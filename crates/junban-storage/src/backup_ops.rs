//! Complete profile backup and atomic restore via private disk staging.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use jiff::Timestamp;
use junban_app::{
    CommittedEvent, CommittedMutation, EventType, RepositoryError, ResourceSnapshot, ResourceType,
    StagedFile,
};
use junban_domain::{
    ActualMinutes, AppSettings, BACKUP_HEADER_LEN, BACKUP_VERSION, BackupError, BackupHeader,
    BackupManifest, CommentBody, CommentId, DreadLevel, EntityName, EstimatedMinutes, HexColor,
    MAX_BACKUP_MANIFEST_BYTES, MAX_BACKUP_PAYLOAD_BYTES, MarkdownText, MonthlyAnchorDay,
    OperationId, Priority, ProjectId, RecurrenceRule, ReminderFenceTerm, ReminderOccurrence,
    ReminderOccurrenceState, SavedFilterId, SectionId, TagId, TagName, Task, TaskId, TaskStatus,
    TaskTitle, TemplateId, TimeBlock, TimeBlockId, TimeSlot, TimeSlotId, TimeZoneName,
    decode_sha256_hex, read_backup_header, sha256_bytes, validate_backup_header,
    validate_task_tags, write_backup_header,
};
use rusqlite::{Connection, MAIN_DB, OptionalExtension, Transaction, backup::Backup, params};
use sha2::{Digest, Sha256};

use crate::migration::{self, CURRENT_SCHEMA_VERSION};
use crate::rows::storage_error;
use crate::{advise_dont_need_pages, ensure_private_dir, set_private_file_permissions};

const BACKUPS_DIR: &str = "backups";
const SETTINGS_KEY: &str = "settings_json";
const BACKUP_STEP_PAGES: i32 = 64;
const BACKUP_STEP_PAUSE: Duration = Duration::from_millis(0);
const COPY_BUFFER_BYTES: usize = 64 * 1024;

/// Create one complete framed `.junban-backup` staged file without a payload-sized buffer.
pub(crate) fn create_backup(
    connection: &Connection,
    profile_dir: &Path,
) -> Result<StagedFile, RepositoryError> {
    ensure_backup_dir(profile_dir)?;
    assert_integrity(connection)?;
    assert_foreign_keys_clean(connection)?;
    assert_canonical_schema(connection, profile_dir)?;

    let inventory = read_inventory(connection)?;
    let schema_version = read_schema_version(connection)?;
    if schema_version != CURRENT_SCHEMA_VERSION {
        return Err(RepositoryError::Storage(format!(
            "cannot backup schema version {schema_version}; expected {CURRENT_SCHEMA_VERSION}"
        )));
    }
    let _settings = read_settings(connection)?;

    let payload_path = temp_backup_path(profile_dir, "payload", "sqlite3");
    if let Err(error) = connection.backup(MAIN_DB, &payload_path, None) {
        let _ = fs::remove_file(&payload_path);
        return Err(storage_error(error));
    }
    set_private_file_permissions(&payload_path).map_err(storage_error)?;
    let payload = StagedFile::new(
        payload_path.clone(),
        fs::metadata(&payload_path).map_err(storage_error)?.len(),
    );

    let snapshot = Connection::open(payload.path()).map_err(storage_error)?;
    snapshot
        .pragma_update(None, "foreign_keys", true)
        .map_err(storage_error)?;
    normalize_runtime_state(&snapshot)?;
    checkpoint_wal(&snapshot)?;
    assert_integrity(&snapshot)?;
    assert_foreign_keys_clean(&snapshot)?;
    assert_canonical_schema(&snapshot, profile_dir)?;
    let normalized_inventory = read_inventory(&snapshot)?;
    drop(snapshot);

    let payload_len = fs::metadata(payload.path()).map_err(storage_error)?.len();
    if payload_len == 0 || payload_len > MAX_BACKUP_PAYLOAD_BYTES {
        return Err(map_backup_error(BackupError::PayloadTooLarge(payload_len)));
    }
    let payload_hash = hash_file(payload.path())?;
    let manifest = BackupManifest {
        artifact_version: BACKUP_VERSION,
        schema_version,
        created_at: Timestamp::now().to_string(),
        payload_sha256: hex_digest(payload_hash),
        task_count: normalized_inventory.task_count,
        project_count: normalized_inventory.project_count,
        tag_count: normalized_inventory.tag_count,
        event_count: normalized_inventory.event_count,
        revision: inventory.revision,
    };
    let manifest_json = serde_json::to_vec(&manifest).map_err(storage_error)?;
    let manifest_len = u32::try_from(manifest_json.len())
        .map_err(|_| map_backup_error(BackupError::ManifestTooLarge(u32::MAX)))?;
    if manifest_len == 0 || manifest_len > MAX_BACKUP_MANIFEST_BYTES {
        return Err(map_backup_error(BackupError::ManifestTooLarge(
            manifest_len,
        )));
    }

    let artifact_path = temp_backup_path(profile_dir, "download", "junban-backup");
    let mut artifact = create_private_new(&artifact_path).map_err(storage_error)?;
    let header = BackupHeader {
        magic: *junban_domain::BACKUP_MAGIC,
        version: BACKUP_VERSION,
        manifest_len,
        manifest_sha256: sha256_bytes(&manifest_json),
        payload_len,
    };
    if let Err(error) = (|| -> io::Result<()> {
        write_backup_header(&header, &mut artifact)?;
        artifact.write_all(&manifest_json)?;
        io::copy(&mut File::open(payload.path())?, &mut artifact)?;
        artifact.sync_all()
    })() {
        let _ = fs::remove_file(&artifact_path);
        return Err(storage_error(error));
    }
    let len = fs::metadata(&artifact_path).map_err(storage_error)?.len();
    Ok(StagedFile::new(artifact_path, len))
}

/// Fully validate a staged envelope and return its epoch-rotated SQLite candidate.
///
/// This performs all hostile-input work before the server enters maintenance.
pub(crate) fn prepare_restore(
    profile_dir: &Path,
    upload: StagedFile,
) -> Result<StagedFile, RepositoryError> {
    ensure_backup_dir(profile_dir)?;
    if upload.is_empty() {
        return Err(RepositoryError::Validation(
            junban_domain::ValidationError::Empty { field: "backup" },
        ));
    }

    let mut source = File::open(upload.path()).map_err(storage_error)?;
    let header = read_backup_header(&mut source)
        .map_err(BackupError::from)
        .map_err(map_backup_error)?;
    validate_backup_header(&header).map_err(map_backup_error)?;
    let expected_len = u64::try_from(BACKUP_HEADER_LEN)
        .unwrap_or(u64::MAX)
        .saturating_add(u64::from(header.manifest_len))
        .saturating_add(header.payload_len);
    if upload.len() != expected_len {
        return Err(map_backup_error(BackupError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "backup length does not match framing",
        ))));
    }

    let mut manifest_json = vec![0; header.manifest_len as usize];
    source
        .read_exact(&mut manifest_json)
        .map_err(BackupError::from)
        .map_err(map_backup_error)?;
    if sha256_bytes(&manifest_json) != header.manifest_sha256 {
        return Err(map_backup_error(BackupError::ManifestHashMismatch));
    }
    let manifest: BackupManifest = serde_json::from_slice(&manifest_json)
        .map_err(|error| map_backup_error(BackupError::InvalidManifest(error.to_string())))?;
    validate_manifest_basics(&manifest)?;

    let candidate_path = temp_backup_path(profile_dir, "candidate", "sqlite3");
    let mut candidate_file = create_private_new(&candidate_path).map_err(storage_error)?;
    let expected_payload_hash =
        decode_sha256_hex(&manifest.payload_sha256).map_err(map_backup_error)?;
    let actual_payload_hash =
        match copy_exact_hashed(&mut source, &mut candidate_file, header.payload_len) {
            Ok(hash) => hash,
            Err(error) => {
                let _ = fs::remove_file(&candidate_path);
                return Err(map_backup_error(BackupError::Io(error)));
            }
        };
    if actual_payload_hash != expected_payload_hash {
        let _ = fs::remove_file(&candidate_path);
        return Err(map_backup_error(BackupError::PayloadHashMismatch));
    }
    candidate_file.sync_all().map_err(storage_error)?;
    drop(candidate_file);

    let candidate = StagedFile::new(candidate_path, header.payload_len);
    let validated = open_and_validate_payload(candidate.path(), &manifest, profile_dir)?;

    // The candidate carries its fresh epoch through the SQLite backup cutover. There is no
    // crash-sensitive post-copy epoch write.
    let event_epoch = TaskId::new().as_uuid().to_string();
    let updated = validated
        .execute(
            "UPDATE app_state SET event_epoch = ?1 WHERE singleton = 1",
            params![event_epoch],
        )
        .map_err(storage_error)?;
    if updated != 1 {
        return Err(RepositoryError::Storage(
            "app_state row missing while preparing restore".into(),
        ));
    }
    checkpoint_wal(&validated)?;
    validate_payload(&validated, &manifest, profile_dir)?;
    drop(validated);
    Ok(candidate)
}

/// Apply a fully prepared SQLite candidate into the live connection.
///
/// On apply failure after the live database was mutated, attempts rollback from a
/// private pre-apply snapshot. Callers must hold the process maintenance barrier.
pub(crate) fn restore_backup(
    connection: &mut Connection,
    profile_dir: &Path,
    candidate: StagedFile,
) -> Result<(), RepositoryError> {
    ensure_backup_dir(profile_dir)?;
    let validated = Connection::open(candidate.path()).map_err(storage_error)?;
    validated
        .pragma_update(None, "foreign_keys", true)
        .map_err(storage_error)?;
    assert_integrity(&validated)?;
    assert_foreign_keys_clean(&validated)?;
    assert_canonical_schema(&validated, profile_dir)?;
    let _settings = read_settings(&validated)?;
    validate_authoritative_rows(&validated)?;

    checkpoint_wal(connection)?;
    let rollback_path = temp_backup_path(profile_dir, "rollback", "sqlite3");
    if let Err(error) = connection.backup(MAIN_DB, &rollback_path, None) {
        let _ = fs::remove_file(&rollback_path);
        return Err(storage_error(error));
    }
    if let Err(error) = set_private_file_permissions(&rollback_path) {
        let _ = fs::remove_file(&rollback_path);
        return Err(storage_error(error));
    }
    // Durability first, then drop clean rollback pages from the page cache so apply
    // does not retain three full DB images (candidate + rollback + live). The file
    // stays on disk and is re-read if apply fails.
    if let Err(error) = fsync_and_drop_page_cache(&rollback_path) {
        let _ = fs::remove_file(&rollback_path);
        return Err(storage_error(error));
    }

    let apply_result = apply_validated_snapshot(connection, &validated, profile_dir);
    match apply_result {
        Ok(()) => {
            let _ = fs::remove_file(&rollback_path);
            // A successful retry from the running recovery boundary is the only normal-worker
            // path that clears a prior catastrophic marker.
            crate::clear_recovery_required(profile_dir)?;
            Ok(())
        }
        Err(apply_error) => match rollback_live(connection, &rollback_path) {
            Ok(()) => {
                let _ = fs::remove_file(&rollback_path);
                Err(apply_error)
            }
            Err(rollback_error) => {
                // Fail closed across process death even when the damaged SQLite file remains
                // openable. The marker rename and parent-directory fsync complete before the
                // recovery_required error can leave this worker.
                crate::persist_recovery_required(profile_dir)?;
                Err(RepositoryError::CatastrophicRestore {
                    apply: apply_error.to_string(),
                    rollback: rollback_error.to_string(),
                    rollback_path: rollback_path.display().to_string(),
                })
            }
        },
    }
}

fn apply_validated_snapshot(
    live: &mut Connection,
    validated: &Connection,
    profile_dir: &Path,
) -> Result<(), RepositoryError> {
    {
        let backup = Backup::new(validated, live).map_err(storage_error)?;
        backup
            .run_to_completion(BACKUP_STEP_PAGES, BACKUP_STEP_PAUSE, None)
            .map_err(storage_error)?;
    }

    #[cfg(test)]
    record_post_copy_epoch(live)?;

    assert_integrity(live)?;
    assert_foreign_keys_clean(live)?;
    assert_canonical_schema(live, profile_dir)?;
    let _settings = read_settings(live)?;
    let schema_version = read_schema_version(live)?;
    if schema_version != CURRENT_SCHEMA_VERSION {
        return Err(RepositoryError::Storage(format!(
            "restored schema version {schema_version} is not {CURRENT_SCHEMA_VERSION}"
        )));
    }
    checkpoint_wal(live)?;
    Ok(())
}

/// Fsync a private rollback snapshot, then advise the kernel to drop its clean pages.
fn fsync_and_drop_page_cache(path: &Path) -> io::Result<()> {
    let file = File::open(path)?;
    file.sync_all()?;
    advise_dont_need_pages(&file)
}

fn rollback_live(live: &mut Connection, rollback_path: &Path) -> Result<(), RepositoryError> {
    #[cfg(test)]
    if FAIL_ROLLBACK.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return Err(RepositoryError::Storage(
            "injected rollback failure".to_owned(),
        ));
    }
    let source = Connection::open(rollback_path).map_err(storage_error)?;
    {
        let backup = Backup::new(&source, live).map_err(storage_error)?;
        backup
            .run_to_completion(BACKUP_STEP_PAGES, BACKUP_STEP_PAUSE, None)
            .map_err(storage_error)?;
    }
    assert_integrity(live)?;
    assert_foreign_keys_clean(live)?;
    Ok(())
}

fn open_and_validate_payload(
    path: &Path,
    manifest: &BackupManifest,
    profile_dir: &Path,
) -> Result<Connection, RepositoryError> {
    let connection = Connection::open(path).map_err(storage_error)?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(storage_error)?;
    validate_payload(&connection, manifest, profile_dir)?;
    Ok(connection)
}

fn validate_payload(
    connection: &Connection,
    manifest: &BackupManifest,
    profile_dir: &Path,
) -> Result<(), RepositoryError> {
    assert_integrity(connection).map_err(|_| invalid_backup())?;
    assert_foreign_keys_clean(connection).map_err(|_| invalid_backup())?;
    assert_canonical_schema(connection, profile_dir).map_err(|_| invalid_backup())?;

    let schema_version = read_schema_version(connection).map_err(|_| invalid_backup())?;
    if schema_version != manifest.schema_version || schema_version != CURRENT_SCHEMA_VERSION {
        return Err(invalid_backup());
    }

    let _settings = read_settings(connection).map_err(|_| invalid_backup())?;
    validate_authoritative_rows(connection).map_err(|_| invalid_backup())?;
    let inventory = read_inventory(connection).map_err(|_| invalid_backup())?;
    if inventory.task_count != manifest.task_count
        || inventory.project_count != manifest.project_count
        || inventory.tag_count != manifest.tag_count
        || inventory.event_count != manifest.event_count
        || inventory.revision != manifest.revision
    {
        return Err(invalid_backup());
    }
    Ok(())
}

fn validate_manifest_basics(manifest: &BackupManifest) -> Result<(), RepositoryError> {
    if manifest.artifact_version != BACKUP_VERSION {
        return Err(map_backup_error(BackupError::UnsupportedVersion(
            manifest.artifact_version,
        )));
    }
    if manifest.schema_version != CURRENT_SCHEMA_VERSION {
        return Err(map_backup_error(BackupError::UnsupportedVersion(
            manifest.artifact_version,
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
struct Inventory {
    task_count: u64,
    project_count: u64,
    tag_count: u64,
    event_count: u64,
    revision: u64,
}

fn read_inventory(connection: &Connection) -> Result<Inventory, RepositoryError> {
    Ok(Inventory {
        task_count: table_count(connection, "tasks")?,
        project_count: table_count(connection, "projects")?,
        tag_count: table_count(connection, "tags")?,
        event_count: table_count(connection, "events")?,
        revision: connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(storage_error)
            .and_then(|value| {
                u64::try_from(value).map_err(|error| RepositoryError::Storage(error.to_string()))
            })?,
    })
}

fn table_count(connection: &Connection, table: &str) -> Result<u64, RepositoryError> {
    let count: i64 = connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(storage_error)?;
    u64::try_from(count).map_err(|error| RepositoryError::Storage(error.to_string()))
}

fn read_schema_version(connection: &Connection) -> Result<i64, RepositoryError> {
    connection
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .map_err(storage_error)
}

fn read_settings(connection: &Connection) -> Result<AppSettings, RepositoryError> {
    let json: String = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            [SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| RepositoryError::Storage("settings_json row is missing".to_owned()))?;
    let settings: AppSettings = serde_json::from_str(&json).map_err(storage_error)?;
    settings.validate().map_err(crate::helpers::validation)?;
    Ok(settings)
}

const VALIDATION_PAGE_ROWS: i64 = 128;

/// Validate authoritative row values, serialized mutation material, and the event head without
/// ever retaining more than one small keyset page plus one row payload.
fn validate_authoritative_rows(connection: &Connection) -> Result<(), RepositoryError> {
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    let (event_epoch, head): (String, i64) = tx
        .query_row(
            "SELECT event_epoch, global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if table_count(&tx, "app_state")? != 1 {
        return Err(RepositoryError::Storage(
            "app_state must contain one row".to_owned(),
        ));
    }
    TaskId::parse(&event_epoch).map_err(storage_error)?;
    let head = u64::try_from(head).map_err(storage_error)?;

    validate_serialized_size_bounds(&tx)?;
    validate_migration_rows(&tx)?;
    validate_settings_rows(&tx)?;
    validate_loaded_entities(&tx, head)?;
    validate_relation_and_control_rows(&tx, head)?;
    validate_event_rows(&tx, head)?;
    validate_receipt_rows(&tx, head)?;
    validate_graph_invariants(&tx)?;
    tx.commit().map_err(storage_error)
}

fn validate_serialized_size_bounds(tx: &Transaction<'_>) -> Result<(), RepositoryError> {
    let oversized_event: bool = tx
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM events
                WHERE LENGTH(CAST(event_json AS BLOB)) > ?1)",
            [i64::try_from(crate::tx::EVENT_JSON_MAX_BYTES).map_err(storage_error)?],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let oversized_receipt: bool = tx
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM operation_receipts AS receipt
                LEFT JOIN operation_undo AS undo
                    ON undo.source_operation_id = receipt.operation_id
                WHERE LENGTH(CAST(receipt.request_json AS BLOB))
                    + LENGTH(CAST(receipt.response_json AS BLOB))
                    + COALESCE(LENGTH(CAST(undo.inverse_json AS BLOB)), 0)
                    + COALESCE(LENGTH(CAST(undo.post_image_json AS BLOB)), 0) > ?1)",
            [i64::try_from(crate::tx::RECEIPT_MATERIAL_MAX_BYTES).map_err(storage_error)?],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let oversized_settings: bool = tx
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM app_settings
                WHERE LENGTH(CAST(value_json AS BLOB)) > ?1)",
            [i64::try_from(crate::tx::EVENT_JSON_MAX_BYTES).map_err(storage_error)?],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if oversized_event || oversized_receipt || oversized_settings {
        return Err(RepositoryError::Storage(
            "serialized authoritative material exceeds its bound".to_owned(),
        ));
    }
    Ok(())
}

fn validate_migration_rows(tx: &Transaction<'_>) -> Result<(), RepositoryError> {
    let mut statement = tx
        .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
        .map_err(storage_error)?;
    let mut rows = statement.query([]).map_err(storage_error)?;
    let mut expected = 1_i64;
    while let Some(row) = rows.next().map_err(storage_error)? {
        let version: i64 = row.get(0).map_err(storage_error)?;
        let applied_at: String = row.get(1).map_err(storage_error)?;
        if version != expected {
            return Err(RepositoryError::Storage(
                "schema migration history is not contiguous".to_owned(),
            ));
        }
        applied_at.parse::<Timestamp>().map_err(storage_error)?;
        expected += 1;
    }
    if expected - 1 != CURRENT_SCHEMA_VERSION {
        return Err(RepositoryError::Storage(
            "schema migration history is incomplete".to_owned(),
        ));
    }
    Ok(())
}

fn validate_settings_rows(tx: &Transaction<'_>) -> Result<(), RepositoryError> {
    let mut statement = tx
        .prepare("SELECT key, value_json, updated_at FROM app_settings ORDER BY key")
        .map_err(storage_error)?;
    let mut rows = statement.query([]).map_err(storage_error)?;
    let mut count = 0usize;
    while let Some(row) = rows.next().map_err(storage_error)? {
        count += 1;
        let key: String = row.get(0).map_err(storage_error)?;
        let json: String = row.get(1).map_err(storage_error)?;
        let updated_at: String = row.get(2).map_err(storage_error)?;
        if key != SETTINGS_KEY {
            return Err(RepositoryError::Storage("unknown settings row".to_owned()));
        }
        let settings: AppSettings = serde_json::from_str(&json).map_err(storage_error)?;
        settings.validate().map_err(crate::helpers::validation)?;
        updated_at.parse::<Timestamp>().map_err(storage_error)?;
    }
    if count != 1 {
        return Err(RepositoryError::Storage(
            "settings_json must be the only settings row".to_owned(),
        ));
    }
    Ok(())
}

fn validate_loaded_entities(tx: &Transaction<'_>, head: u64) -> Result<(), RepositoryError> {
    scan_text_ids(tx, "tasks", |tx, raw| {
        let task = crate::rows::load_task(tx, TaskId::parse(raw).map_err(storage_error)?)?;
        validate_task_value(&task)?;
        if task.revision > head {
            return Err(RepositoryError::Storage(
                "task revision exceeds event head".to_owned(),
            ));
        }
        Ok(())
    })?;
    scan_text_ids(tx, "projects", |tx, raw| {
        let project = crate::rows::load_project(tx, ProjectId::parse(raw).map_err(storage_error)?)?;
        EntityName::new(project.name.as_str()).map_err(storage_error)?;
        HexColor::new(project.color.as_str()).map_err(storage_error)?;
        if let Some(icon) = &project.icon {
            junban_domain::IconText::new(icon.as_str()).map_err(storage_error)?;
        }
        Ok(())
    })?;
    scan_text_ids(tx, "sections", |tx, raw| {
        let section = crate::rows::load_section(tx, SectionId::parse(raw).map_err(storage_error)?)?;
        EntityName::new(section.name.as_str()).map_err(storage_error)?;
        Ok(())
    })?;
    scan_text_ids(tx, "tags", |tx, raw| {
        let tag = crate::rows::load_tag(tx, TagId::parse(raw).map_err(storage_error)?)?;
        TagName::new(tag.name.as_str()).map_err(storage_error)?;
        HexColor::new(tag.color.as_str()).map_err(storage_error)?;
        Ok(())
    })?;
    scan_text_ids(tx, "templates", |tx, raw| {
        let template =
            crate::rows::load_template(tx, TemplateId::parse(raw).map_err(storage_error)?)?;
        EntityName::new(template.name.as_str()).map_err(storage_error)?;
        TaskTitle::new(template.title.as_str()).map_err(storage_error)?;
        MarkdownText::new(template.description.as_str()).map_err(storage_error)?;
        if let Some(rule) = &template.recurrence_rule {
            RecurrenceRule::new(rule.as_str()).map_err(storage_error)?;
        }
        Ok(())
    })?;
    scan_text_ids(tx, "saved_filters", |tx, raw| {
        let filter =
            crate::rows::load_saved_filter(tx, SavedFilterId::parse(raw).map_err(storage_error)?)?;
        EntityName::new(filter.name.as_str()).map_err(storage_error)?;
        junban_domain::FilterQuery::new(filter.query.as_str()).map_err(storage_error)?;
        Ok(())
    })?;
    scan_text_ids(tx, "comments", |tx, raw| {
        let comment = crate::rows::load_comment(tx, CommentId::parse(raw).map_err(storage_error)?)?;
        CommentBody::new(comment.content.as_str()).map_err(storage_error)?;
        Ok(())
    })?;
    scan_text_ids(tx, "time_blocks", |tx, raw| {
        let block = crate::timeblock_ops::load_time_block(
            tx,
            TimeBlockId::parse(raw).map_err(storage_error)?,
        )?;
        validate_time_block_value(&block)?;
        if block.revision > head {
            return Err(RepositoryError::Storage(
                "time block revision exceeds event head".to_owned(),
            ));
        }
        Ok(())
    })?;
    scan_text_ids(tx, "time_slots", |tx, raw| {
        let slot = crate::timeblock_ops::load_time_slot(
            tx,
            TimeSlotId::parse(raw).map_err(storage_error)?,
        )?;
        validate_time_slot_value(&slot)?;
        if slot.revision > head {
            return Err(RepositoryError::Storage(
                "time slot revision exceeds event head".to_owned(),
            ));
        }
        Ok(())
    })?;
    Ok(())
}

fn scan_text_ids(
    tx: &Transaction<'_>,
    table: &str,
    mut validate: impl FnMut(&Transaction<'_>, &str) -> Result<(), RepositoryError>,
) -> Result<(), RepositoryError> {
    let mut after: Option<String> = None;
    loop {
        let sql =
            format!("SELECT id FROM {table} WHERE (?1 IS NULL OR id > ?1) ORDER BY id LIMIT ?2");
        let mut statement = tx.prepare(&sql).map_err(storage_error)?;
        let ids = statement
            .query_map(params![after.as_deref(), VALIDATION_PAGE_ROWS], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        if ids.is_empty() {
            break;
        }
        for id in &ids {
            validate(tx, id)?;
        }
        after = ids.last().cloned();
        if ids.len() < VALIDATION_PAGE_ROWS as usize {
            break;
        }
    }
    Ok(())
}

fn validate_relation_and_control_rows(
    tx: &Transaction<'_>,
    head: u64,
) -> Result<(), RepositoryError> {
    {
        let mut statement = tx
            .prepare("SELECT from_task_id, to_task_id, kind FROM task_relations")
            .map_err(storage_error)?;
        let mut rows = statement.query([]).map_err(storage_error)?;
        while let Some(row) = rows.next().map_err(storage_error)? {
            let from: String = row.get(0).map_err(storage_error)?;
            let to: String = row.get(1).map_err(storage_error)?;
            let kind: String = row.get(2).map_err(storage_error)?;
            let from = TaskId::parse(&from).map_err(storage_error)?;
            let to = TaskId::parse(&to).map_err(storage_error)?;
            if kind != "blocks" || from == to {
                return Err(RepositoryError::Storage("invalid task relation".to_owned()));
            }
        }
    }
    {
        let mut statement = tx
            .prepare("SELECT name, name_normalized FROM tags ORDER BY id")
            .map_err(storage_error)?;
        let mut rows = statement.query([]).map_err(storage_error)?;
        while let Some(row) = rows.next().map_err(storage_error)? {
            let name: String = row.get(0).map_err(storage_error)?;
            let normalized: String = row.get(1).map_err(storage_error)?;
            if normalized != crate::rows::normalize_tag_name(&name) {
                return Err(RepositoryError::Storage(
                    "tag normalized name is inconsistent".to_owned(),
                ));
            }
        }
    }
    for (table, left, right) in [
        ("task_tags", "task_id", "tag_id"),
        ("template_tags", "template_id", "tag_id"),
    ] {
        let mut statement = tx
            .prepare(&format!("SELECT {left}, {right} FROM {table}"))
            .map_err(storage_error)?;
        let mut rows = statement.query([]).map_err(storage_error)?;
        while let Some(row) = rows.next().map_err(storage_error)? {
            let left: String = row.get(0).map_err(storage_error)?;
            let right: String = row.get(1).map_err(storage_error)?;
            match table {
                "task_tags" => {
                    TaskId::parse(&left).map_err(storage_error)?;
                }
                _ => {
                    TemplateId::parse(&left).map_err(storage_error)?;
                }
            }
            TagId::parse(&right).map_err(storage_error)?;
        }
    }
    {
        let mut statement = tx
            .prepare("SELECT slot_id, task_id, position FROM time_slot_tasks")
            .map_err(storage_error)?;
        let mut rows = statement.query([]).map_err(storage_error)?;
        while let Some(row) = rows.next().map_err(storage_error)? {
            TimeSlotId::parse(&row.get::<_, String>(0).map_err(storage_error)?)
                .map_err(storage_error)?;
            TaskId::parse(&row.get::<_, String>(1).map_err(storage_error)?)
                .map_err(storage_error)?;
            let position: i64 = row.get(2).map_err(storage_error)?;
            if position < 0 {
                return Err(RepositoryError::Storage("invalid slot position".to_owned()));
            }
        }
    }
    {
        let mut statement = tx
            .prepare(
                "SELECT revision, sequence, operation_id, task_id, action, field,
                        old_value, new_value, created_at FROM task_activity
                 ORDER BY revision, sequence",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], crate::rows::activity_from_row)
            .map_err(storage_error)?;
        for row in rows {
            let activity = row.map_err(storage_error)?;
            if activity.revision == 0 || activity.revision > head {
                return Err(RepositoryError::Storage(
                    "task activity revision exceeds event head".to_owned(),
                ));
            }
        }
    }
    {
        let mut statement = tx
            .prepare(
                "SELECT revision, operation_id, kind, subject_type, subject_id, created_at
                 FROM activity ORDER BY revision",
            )
            .map_err(storage_error)?;
        let mut rows = statement.query([]).map_err(storage_error)?;
        let mut count = 0_u64;
        let mut last = 0_u64;
        while let Some(row) = rows.next().map_err(storage_error)? {
            let revision = u64::try_from(row.get::<_, i64>(0).map_err(storage_error)?)
                .map_err(storage_error)?;
            OperationId::parse(&row.get::<_, String>(1).map_err(storage_error)?)
                .map_err(storage_error)?;
            validate_event_type(&row.get::<_, String>(2).map_err(storage_error)?)?;
            validate_subject(
                row.get::<_, Option<String>>(3).map_err(storage_error)?,
                row.get::<_, Option<String>>(4).map_err(storage_error)?,
            )?;
            row.get::<_, String>(5)
                .map_err(storage_error)?
                .parse::<Timestamp>()
                .map_err(storage_error)?;
            count += 1;
            last = revision;
        }
        if count != head || last != head {
            return Err(RepositoryError::Storage(
                "activity summary is inconsistent with app_state".to_owned(),
            ));
        }
    }
    {
        let mut statement = tx
            .prepare(
                "SELECT task_id, remind_at, state, claim_term, claim_expires_at, attempts,
                        next_attempt_at, terminal_channel, terminal_error_code, created_at, updated_at
                 FROM reminder_occurrences ORDER BY task_id, remind_at",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], crate::reminder_ops::map_occurrence_row)
            .map_err(storage_error)?;
        for row in rows {
            validate_reminder_value(&row.map_err(storage_error)?)?;
        }
        let _ = crate::reminder_ops::read_lease(tx)?;
    }
    Ok(())
}

fn validate_event_rows(tx: &Transaction<'_>, head: u64) -> Result<(), RepositoryError> {
    let mut after = 0_u64;
    let mut first = None;
    let mut count = 0_u64;
    loop {
        let mut statement = tx
            .prepare(
                "SELECT revision, event_type, operation_id, event_json, occurred_at
                 FROM events WHERE revision > ?1 ORDER BY revision LIMIT ?2",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(
                params![
                    i64::try_from(after).map_err(storage_error)?,
                    VALIDATION_PAGE_ROWS
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        if rows.is_empty() {
            break;
        }
        for (revision, event_type, operation_id, json, occurred_at) in &rows {
            let revision = u64::try_from(*revision).map_err(storage_error)?;
            first.get_or_insert(revision);
            if json.len() > crate::tx::EVENT_JSON_MAX_BYTES {
                return Err(RepositoryError::Storage(
                    "event payload is oversized".to_owned(),
                ));
            }
            let event: CommittedEvent = serde_json::from_str(json).map_err(storage_error)?;
            validate_committed_event(&event)?;
            if event.revision != revision
                || event.event_type.as_str() != event_type
                || event.operation_id.to_string() != *operation_id
                || event.occurred_at.to_string() != *occurred_at
            {
                return Err(RepositoryError::Storage(
                    "event columns disagree with serialized event".to_owned(),
                ));
            }
            after = revision;
            count += 1;
        }
        if rows.len() < VALIDATION_PAGE_ROWS as usize {
            break;
        }
    }
    if head == 0 {
        if count != 0 {
            return Err(RepositoryError::Storage(
                "events exist at revision zero".to_owned(),
            ));
        }
    } else if after != head
        || first.is_some_and(|oldest| count != head.saturating_sub(oldest).saturating_add(1))
    {
        return Err(RepositoryError::Storage(
            "retained event history is inconsistent with app_state".to_owned(),
        ));
    }
    let summary_mismatch: bool = tx
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM events
                JOIN activity ON activity.revision = events.revision
                WHERE activity.operation_id != events.operation_id
                   OR activity.kind != events.event_type
                   OR activity.created_at != events.occurred_at)",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if summary_mismatch {
        return Err(RepositoryError::Storage(
            "event and activity summary disagree".to_owned(),
        ));
    }
    Ok(())
}

fn validate_receipt_rows(tx: &Transaction<'_>, head: u64) -> Result<(), RepositoryError> {
    let mut after: Option<String> = None;
    loop {
        let mut statement = tx
            .prepare(
                "SELECT operation_id, request_json, response_json, created_at, expires_at
                 FROM operation_receipts
                 WHERE (?1 IS NULL OR operation_id > ?1)
                 ORDER BY operation_id LIMIT ?2",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(params![after.as_deref(), VALIDATION_PAGE_ROWS], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        if rows.is_empty() {
            break;
        }
        for (operation_id, request_json, response_json, created_at, expires_at) in &rows {
            let operation_id = OperationId::parse(operation_id).map_err(storage_error)?;
            let request: serde_json::Value =
                serde_json::from_str(request_json).map_err(storage_error)?;
            if !request.is_object() {
                return Err(RepositoryError::Storage(
                    "receipt request is not a contract object".to_owned(),
                ));
            }
            let response: CommittedMutation =
                serde_json::from_str(response_json).map_err(storage_error)?;
            validate_committed_event(&response.event)?;
            if response.event.operation_id != operation_id || response.event.revision > head {
                return Err(RepositoryError::Storage(
                    "receipt response identity is inconsistent".to_owned(),
                ));
            }
            let retained_event: Option<String> = tx
                .query_row(
                    "SELECT event_json FROM events WHERE revision = ?1",
                    [i64::try_from(response.event.revision).map_err(storage_error)?],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage_error)?;
            if let Some(retained_event) = retained_event {
                let retained: CommittedEvent =
                    serde_json::from_str(&retained_event).map_err(storage_error)?;
                if retained != response.event {
                    return Err(RepositoryError::Storage(
                        "receipt response disagrees with retained event".to_owned(),
                    ));
                }
            }
            match (created_at, expires_at) {
                (Some(created), Some(expires)) => {
                    created.parse::<Timestamp>().map_err(storage_error)?;
                    expires.parse::<Timestamp>().map_err(storage_error)?;
                }
                (None, None) => {}
                _ => {
                    return Err(RepositoryError::Storage(
                        "receipt retention timestamps are incomplete".to_owned(),
                    ));
                }
            }
            after = Some(operation_id.to_string());
        }
        if rows.len() < VALIDATION_PAGE_ROWS as usize {
            break;
        }
    }

    let mut statement = tx
        .prepare(
            "SELECT source_operation_id, source_revision, inverse_json, post_image_json,
                    undone_by_operation_id, undone_at
             FROM operation_undo ORDER BY source_operation_id",
        )
        .map_err(storage_error)?;
    let mut rows = statement.query([]).map_err(storage_error)?;
    while let Some(row) = rows.next().map_err(storage_error)? {
        OperationId::parse(&row.get::<_, String>(0).map_err(storage_error)?)
            .map_err(storage_error)?;
        let source_revision =
            u64::try_from(row.get::<_, i64>(1).map_err(storage_error)?).map_err(storage_error)?;
        if source_revision == 0 || source_revision > head {
            return Err(RepositoryError::Storage(
                "invalid undo source revision".to_owned(),
            ));
        }
        let source_operation_id: String = row.get(0).map_err(storage_error)?;
        let receipt_response: String = tx
            .query_row(
                "SELECT response_json FROM operation_receipts WHERE operation_id = ?1",
                [&source_operation_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        let source_response: CommittedMutation =
            serde_json::from_str(&receipt_response).map_err(storage_error)?;
        if source_response.event.revision != source_revision {
            return Err(RepositoryError::Storage(
                "undo source revision disagrees with receipt".to_owned(),
            ));
        }
        let inverse_json: String = row.get(2).map_err(storage_error)?;
        let post_json: String = row.get(3).map_err(storage_error)?;
        let inverse: crate::ops_types::Inverse =
            serde_json::from_str(&inverse_json).map_err(storage_error)?;
        let post: crate::ops_types::PostImage =
            serde_json::from_str(&post_json).map_err(storage_error)?;
        validate_inverse(&inverse)?;
        validate_post_image(&post)?;
        let undone_by: Option<String> = row.get(4).map_err(storage_error)?;
        let undone_at: Option<String> = row.get(5).map_err(storage_error)?;
        match (undone_by, undone_at) {
            (Some(id), Some(at)) => {
                OperationId::parse(&id).map_err(storage_error)?;
                at.parse::<Timestamp>().map_err(storage_error)?;
            }
            (None, None) => {}
            _ => return Err(RepositoryError::Storage("invalid undo state".to_owned())),
        }
    }
    Ok(())
}

fn validate_parent_graph(
    tx: &Transaction<'_>,
    table: &str,
    parent_column: &str,
) -> Result<(), RepositoryError> {
    let mut after: Option<String> = None;
    loop {
        let page_sql = format!(
            "SELECT id FROM {table}
             WHERE {parent_column} IS NOT NULL AND (?1 IS NULL OR id > ?1)
             ORDER BY id LIMIT ?2"
        );
        let mut statement = tx.prepare(&page_sql).map_err(storage_error)?;
        let roots = statement
            .query_map(params![after.as_deref(), VALIDATION_PAGE_ROWS], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        if roots.is_empty() {
            break;
        }
        let walk_sql = format!(
            "WITH RECURSIVE chain(node) AS (
                SELECT {parent_column} FROM {table}
                WHERE id = ?1 AND {parent_column} IS NOT NULL
                UNION
                SELECT row.{parent_column} FROM {table} AS row
                JOIN chain ON row.id = chain.node
                WHERE row.{parent_column} IS NOT NULL
             )
             SELECT EXISTS(SELECT 1 FROM chain WHERE node = ?1)"
        );
        for root in &roots {
            let cycle: bool = tx
                .query_row(&walk_sql, [root], |row| row.get(0))
                .map_err(storage_error)?;
            if cycle {
                return Err(RepositoryError::Storage(
                    "persisted hierarchy contains a cycle".to_owned(),
                ));
            }
        }
        after = roots.last().cloned();
        if roots.len() < VALIDATION_PAGE_ROWS as usize {
            break;
        }
    }
    Ok(())
}

fn validate_relation_graph(tx: &Transaction<'_>) -> Result<(), RepositoryError> {
    let mut after: Option<String> = None;
    loop {
        let mut statement = tx
            .prepare(
                "SELECT DISTINCT from_task_id FROM task_relations
                 WHERE (?1 IS NULL OR from_task_id > ?1)
                 ORDER BY from_task_id LIMIT ?2",
            )
            .map_err(storage_error)?;
        let roots = statement
            .query_map(params![after.as_deref(), VALIDATION_PAGE_ROWS], |row| {
                row.get::<_, String>(0)
            })
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        if roots.is_empty() {
            break;
        }
        for root in &roots {
            let cycle: bool = tx
                .query_row(
                    "WITH RECURSIVE chain(node) AS (
                        SELECT to_task_id FROM task_relations WHERE from_task_id = ?1
                        UNION
                        SELECT relation.to_task_id FROM task_relations AS relation
                        JOIN chain ON relation.from_task_id = chain.node
                     )
                     SELECT EXISTS(SELECT 1 FROM chain WHERE node = ?1)",
                    [root],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if cycle {
                return Err(RepositoryError::Storage(
                    "persisted relation graph contains a cycle".to_owned(),
                ));
            }
        }
        after = roots.last().cloned();
        if roots.len() < VALIDATION_PAGE_ROWS as usize {
            break;
        }
    }
    Ok(())
}

fn validate_graph_invariants(tx: &Transaction<'_>) -> Result<(), RepositoryError> {
    // Walk one root at a time from keyset pages. A hostile deep chain can retain only that
    // chain in SQLite's recursive working set, never the whole profile's transitive closure.
    validate_parent_graph(tx, "tasks", "parent_id")?;
    validate_parent_graph(tx, "projects", "parent_id")?;
    validate_parent_graph(tx, "tasks", "recurrence_source_id")?;
    validate_parent_graph(tx, "time_blocks", "recurrence_parent_id")?;
    validate_parent_graph(tx, "time_slots", "recurrence_parent_id")?;
    validate_relation_graph(tx)?;

    let invalid_section: bool = tx
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM tasks JOIN sections ON sections.id = tasks.section_id
                WHERE tasks.project_id IS NULL OR tasks.project_id != sections.project_id)",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let too_many_tags: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM task_tags GROUP BY task_id HAVING COUNT(*) > 100)",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let invalid_slot_positions: bool = tx
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM (
                    SELECT slot_id, COUNT(*) AS count, MAX(position) AS max_position
                    FROM time_slot_tasks GROUP BY slot_id
                ) WHERE max_position != count - 1 OR count > 100)",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if invalid_section || too_many_tags || invalid_slot_positions {
        return Err(RepositoryError::Storage(
            "persisted relationship invariant is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_event_type(raw: &str) -> Result<(), RepositoryError> {
    if matches!(
        raw,
        EventType::TASK_CREATED
            | EventType::TASK_UPDATED
            | EventType::TASK_COMPLETED
            | EventType::TASK_UNCOMPLETED
            | EventType::TASK_CANCELLED
            | EventType::TASK_REOPENED
            | EventType::TASK_DELETED
            | EventType::TASK_MOVED
            | EventType::TASK_REORDERED
            | EventType::TASK_BULK
            | EventType::TASK_RESTORED
            | EventType::PROJECT_CREATED
            | EventType::PROJECT_UPDATED
            | EventType::PROJECT_DELETED
            | EventType::SECTION_CREATED
            | EventType::SECTION_UPDATED
            | EventType::SECTION_DELETED
            | EventType::TAG_CREATED
            | EventType::TAG_UPDATED
            | EventType::TAG_DELETED
            | EventType::TEMPLATE_CREATED
            | EventType::TEMPLATE_UPDATED
            | EventType::TEMPLATE_DELETED
            | EventType::TEMPLATE_APPLIED
            | EventType::SAVED_FILTER_CREATED
            | EventType::SAVED_FILTER_UPDATED
            | EventType::SAVED_FILTER_DELETED
            | EventType::COMMENT_CREATED
            | EventType::COMMENT_UPDATED
            | EventType::COMMENT_DELETED
            | EventType::RELATION_ADDED
            | EventType::RELATION_REMOVED
            | EventType::OPERATION_UNDONE
            | EventType::TIME_BLOCK_CREATED
            | EventType::TIME_BLOCK_UPDATED
            | EventType::TIME_BLOCK_DELETED
            | EventType::TIME_BLOCK_REPLANNED
            | EventType::TIME_SLOT_CREATED
            | EventType::TIME_SLOT_UPDATED
            | EventType::TIME_SLOT_DELETED
            | EventType::TIME_SLOT_MEMBERSHIP_UPDATED
            | EventType::SETTINGS_UPDATED
            | EventType::IMPORT_APPLIED
    ) {
        Ok(())
    } else {
        Err(RepositoryError::Storage("unknown event type".to_owned()))
    }
}

fn validate_subject(
    subject_type: Option<String>,
    subject_id: Option<String>,
) -> Result<(), RepositoryError> {
    match (subject_type.as_deref(), subject_id.as_deref()) {
        (None, None) => Ok(()),
        (Some("task"), Some(id)) => TaskId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("project"), Some(id)) => ProjectId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("section"), Some(id)) => SectionId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("tag"), Some(id)) => TagId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("template"), Some(id)) => TemplateId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("saved_filter"), Some(id)) => {
            SavedFilterId::parse(id).map(|_| ()).map_err(storage_error)
        }
        (Some("comment"), Some(id)) => CommentId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("time_block"), Some("replan")) => Ok(()),
        (Some("time_block"), Some(id)) => TimeBlockId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("time_slot"), Some(id)) => TimeSlotId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("operation"), Some(id)) => OperationId::parse(id).map(|_| ()).map_err(storage_error),
        (Some("settings"), Some("settings")) | (Some("import"), Some(_)) => Ok(()),
        _ => Err(RepositoryError::Storage(
            "invalid activity subject".to_owned(),
        )),
    }
}

fn validate_committed_event(event: &CommittedEvent) -> Result<(), RepositoryError> {
    if event.revision == 0 {
        return Err(RepositoryError::Storage(
            "event revision is zero".to_owned(),
        ));
    }
    validate_event_type(event.event_type.as_str())?;
    if let Some(primary) = &event.primary {
        validate_resource_id(primary.resource_type, &primary.id)?;
    }
    validate_task_ids(&event.affected.task_ids)?;
    for count in [
        event.affected.project_ids.len(),
        event.affected.section_ids.len(),
        event.affected.tag_ids.len(),
        event.affected.template_ids.len(),
        event.affected.saved_filter_ids.len(),
        event.affected.comment_ids.len(),
        event.affected.time_block_ids.len(),
        event.affected.time_slot_ids.len(),
    ] {
        if count > junban_domain::MAX_BULK_IDS {
            return Err(RepositoryError::Storage(
                "event affected IDs exceed the bounded contract".to_owned(),
            ));
        }
    }
    if let Some(snapshot) = &event.snapshot {
        match snapshot {
            ResourceSnapshot::Task { task } => validate_task_value(task)?,
            ResourceSnapshot::Project { project } => {
                EntityName::new(project.name.as_str()).map_err(storage_error)?;
                HexColor::new(project.color.as_str()).map_err(storage_error)?;
            }
            ResourceSnapshot::Section { section } => {
                EntityName::new(section.name.as_str()).map_err(storage_error)?;
            }
            ResourceSnapshot::Tag { tag } => {
                TagName::new(tag.name.as_str()).map_err(storage_error)?;
                HexColor::new(tag.color.as_str()).map_err(storage_error)?;
            }
            ResourceSnapshot::Template { template } => {
                EntityName::new(template.name.as_str()).map_err(storage_error)?;
                TaskTitle::new(template.title.as_str()).map_err(storage_error)?;
            }
            ResourceSnapshot::SavedFilter { saved_filter } => {
                EntityName::new(saved_filter.name.as_str()).map_err(storage_error)?;
                junban_domain::FilterQuery::new(saved_filter.query.as_str())
                    .map_err(storage_error)?;
            }
            ResourceSnapshot::Comment { comment } => {
                CommentBody::new(comment.content.as_str()).map_err(storage_error)?;
            }
            ResourceSnapshot::TimeBlock { time_block } => validate_time_block_value(time_block)?,
            ResourceSnapshot::TimeSlot { time_slot } => validate_time_slot_value(time_slot)?,
        }
    }
    Ok(())
}

fn validate_resource_id(kind: ResourceType, id: &str) -> Result<(), RepositoryError> {
    match kind {
        ResourceType::Task => TaskId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Project => ProjectId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Section => SectionId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Tag => TagId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Template => TemplateId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::SavedFilter => SavedFilterId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Comment => CommentId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Operation => OperationId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::TimeBlock => TimeBlockId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::TimeSlot => TimeSlotId::parse(id).map(|_| ()).map_err(storage_error),
        ResourceType::Settings if id == "settings" => Ok(()),
        ResourceType::Relation => Ok(()),
        _ => Err(RepositoryError::Storage(
            "invalid event resource id".to_owned(),
        )),
    }
}

fn validate_task_value(task: &Task) -> Result<(), RepositoryError> {
    TaskTitle::new(task.title.as_str()).map_err(storage_error)?;
    MarkdownText::new(task.description.as_str()).map_err(storage_error)?;
    validate_task_tags(&task.tag_ids).map_err(storage_error)?;
    if let Some(priority) = task.priority {
        Priority::new(priority.get()).map_err(storage_error)?;
    }
    if let Some(dread) = task.dread {
        DreadLevel::new(dread.get()).map_err(storage_error)?;
    }
    if let Some(minutes) = task.estimated_minutes {
        EstimatedMinutes::new(minutes.get()).map_err(storage_error)?;
    }
    if let Some(minutes) = task.actual_minutes {
        ActualMinutes::new(minutes.get()).map_err(storage_error)?;
    }
    if let Some(day) = task.recurrence_anchor_day {
        MonthlyAnchorDay::new(day.get()).map_err(storage_error)?;
        if task.recurrence_rule.is_none() {
            return Err(RepositoryError::Storage(
                "task recurrence anchor has no rule".to_owned(),
            ));
        }
    }
    if let Some(rule) = &task.recurrence_rule {
        RecurrenceRule::new(rule.as_str()).map_err(storage_error)?;
    }
    if let Some(due_time) = &task.due_time {
        TimeZoneName::new(due_time.time_zone.as_str()).map_err(storage_error)?;
        if task.due_date.is_none() {
            return Err(RepositoryError::Storage(
                "task due time has no date".to_owned(),
            ));
        }
    }
    if task.section_id.is_some() && task.project_id.is_none()
        || task.parent_id == Some(task.id)
        || task.recurrence_source_id == Some(task.id)
        || task.revision == 0
    {
        return Err(RepositoryError::Storage(
            "invalid task relationship".to_owned(),
        ));
    }
    match task.status {
        TaskStatus::Completed if task.completed_at.is_some() && task.cancelled_at.is_none() => {}
        TaskStatus::Cancelled if task.completed_at.is_none() && task.cancelled_at.is_some() => {}
        TaskStatus::Pending if task.completed_at.is_none() && task.cancelled_at.is_none() => {}
        _ => {
            return Err(RepositoryError::Storage(
                "invalid task status timestamps".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_time_block_value(block: &TimeBlock) -> Result<(), RepositoryError> {
    EntityName::new(block.title.as_str()).map_err(storage_error)?;
    block.range.validate().map_err(storage_error)?;
    TimeZoneName::new(block.range.time_zone.as_str()).map_err(storage_error)?;
    if let Some(color) = &block.color {
        HexColor::new(color.as_str()).map_err(storage_error)?;
    }
    if let Some(rule) = &block.recurrence_rule {
        RecurrenceRule::new(rule.as_str()).map_err(storage_error)?;
    }
    if block.recurrence_parent_id == Some(block.id) || block.revision == 0 {
        return Err(RepositoryError::Storage("invalid time block".to_owned()));
    }
    Ok(())
}

fn validate_time_slot_value(slot: &TimeSlot) -> Result<(), RepositoryError> {
    EntityName::new(slot.title.as_str()).map_err(storage_error)?;
    slot.range.validate().map_err(storage_error)?;
    TimeZoneName::new(slot.range.time_zone.as_str()).map_err(storage_error)?;
    if let Some(color) = &slot.color {
        HexColor::new(color.as_str()).map_err(storage_error)?;
    }
    if let Some(rule) = &slot.recurrence_rule {
        RecurrenceRule::new(rule.as_str()).map_err(storage_error)?;
    }
    junban_domain::OrderedSlotMembership::new(slot.task_ids.as_slice().to_vec())
        .map_err(storage_error)?;
    if slot.recurrence_parent_id == Some(slot.id) || slot.revision == 0 {
        return Err(RepositoryError::Storage("invalid time slot".to_owned()));
    }
    Ok(())
}

fn validate_reminder_value(reminder: &ReminderOccurrence) -> Result<(), RepositoryError> {
    if let Some(term) = &reminder.claim_term {
        ReminderFenceTerm::parse(term.as_str()).map_err(storage_error)?;
    }
    let valid = match reminder.state {
        ReminderOccurrenceState::Pending => {
            reminder.claim_term.is_none()
                && reminder.claim_expires_at.is_none()
                && reminder.terminal_channel.is_none()
        }
        ReminderOccurrenceState::Claimed => {
            reminder.claim_term.is_some()
                && reminder.claim_expires_at.is_some()
                && reminder.next_attempt_at.is_none()
                && reminder.terminal_channel.is_none()
                && reminder.terminal_error_code.is_none()
        }
        ReminderOccurrenceState::Delivered => {
            reminder.claim_term.is_some()
                && reminder.claim_expires_at.is_none()
                && reminder.next_attempt_at.is_none()
                && reminder.terminal_channel.is_some()
                && reminder.terminal_error_code.is_none()
        }
        ReminderOccurrenceState::Failed => {
            reminder.claim_term.is_some()
                && reminder.claim_expires_at.is_none()
                && reminder.next_attempt_at.is_none()
                && reminder.terminal_channel.is_none()
                && reminder.terminal_error_code.is_some()
        }
        ReminderOccurrenceState::Cancelled => {
            reminder.claim_term.is_none()
                && reminder.claim_expires_at.is_none()
                && reminder.next_attempt_at.is_none()
                && reminder.terminal_channel.is_none()
        }
    };
    if valid {
        Ok(())
    } else {
        Err(RepositoryError::Storage(
            "invalid reminder claim state".to_owned(),
        ))
    }
}

fn validate_inverse(inverse: &crate::ops_types::Inverse) -> Result<(), RepositoryError> {
    use crate::ops_types::Inverse;
    match inverse {
        Inverse::DeleteTasks { task_ids } => validate_task_ids(task_ids),
        Inverse::DeleteImport {
            task_ids,
            projects,
            tags,
        } => {
            validate_task_ids(task_ids)?;
            for project in projects {
                validate_project_value(project)?;
            }
            for tag in tags {
                validate_tag_value(tag)?;
            }
            Ok(())
        }
        Inverse::RestoreImport {
            tasks,
            projects,
            tags,
        } => {
            validate_task_collection(tasks)?;
            for project in projects {
                validate_project_value(project)?;
            }
            for tag in tags {
                validate_tag_value(tag)?;
            }
            Ok(())
        }
        Inverse::RestoreClosure { closure } => {
            validate_task_collection(&closure.tasks)?;
            for comment in &closure.comments {
                validate_comment_value(comment)?;
            }
            for relation in &closure.relations {
                validate_relation_value(relation)?;
            }
            for activity in &closure.activity {
                if activity.revision == 0 {
                    return Err(RepositoryError::Storage(
                        "invalid activity in undo closure".to_owned(),
                    ));
                }
            }
            for reminder in &closure.reminders {
                validate_reminder_value(reminder)?;
            }
            validate_planning_links(&closure.slot_memberships, &closure.block_links)?;
            Ok(())
        }
        Inverse::RestoreTasks {
            tasks,
            reminders,
            slot_memberships,
            block_links,
        } => {
            validate_task_collection(tasks)?;
            for reminder in reminders {
                validate_reminder_value(reminder)?;
            }
            validate_planning_links(slot_memberships, block_links)?;
            Ok(())
        }
        Inverse::ReverseCompletion {
            sources,
            generated_ids,
            source_reminders,
        } => {
            validate_task_collection(sources)?;
            validate_task_ids(generated_ids)?;
            validate_disjoint_task_id_union(
                &sources.iter().map(|task| task.id).collect::<Vec<_>>(),
                generated_ids,
            )?;
            for reminder in source_reminders {
                validate_reminder_value(reminder)?;
            }
            Ok(())
        }
        Inverse::RestoreOrders { orders } => {
            validate_task_ids(&orders.iter().map(|(id, _)| *id).collect::<Vec<_>>())
        }
        Inverse::RestoreComment { before, .. } => {
            if let Some(comment) = before {
                validate_comment_value(comment)?;
            }
            Ok(())
        }
        Inverse::RestoreRelation { relation, .. } => validate_relation_value(relation),
    }
}

fn validate_project_value(project: &junban_domain::Project) -> Result<(), RepositoryError> {
    EntityName::new(project.name.as_str()).map_err(storage_error)?;
    HexColor::new(project.color.as_str()).map_err(storage_error)?;
    if let Some(icon) = &project.icon {
        junban_domain::IconText::new(icon.as_str()).map_err(storage_error)?;
    }
    if project.parent_id == Some(project.id) {
        return Err(RepositoryError::Storage(
            "invalid project parent".to_owned(),
        ));
    }
    Ok(())
}

fn validate_tag_value(tag: &junban_domain::Tag) -> Result<(), RepositoryError> {
    TagName::new(tag.name.as_str()).map_err(storage_error)?;
    HexColor::new(tag.color.as_str()).map_err(storage_error)?;
    Ok(())
}

fn validate_comment_value(comment: &junban_domain::Comment) -> Result<(), RepositoryError> {
    CommentBody::new(comment.content.as_str()).map_err(storage_error)?;
    Ok(())
}

fn validate_relation_value(relation: &junban_domain::TaskRelation) -> Result<(), RepositoryError> {
    if relation.from_task_id == relation.to_task_id {
        Err(RepositoryError::Storage("invalid undo relation".to_owned()))
    } else {
        Ok(())
    }
}

fn validate_planning_links(
    memberships: &[crate::ops_types::ClosureSlotMembership],
    links: &[crate::ops_types::ClosureBlockLink],
) -> Result<(), RepositoryError> {
    if memberships.len() > junban_domain::MAX_BULK_IDS
        || links.len() > junban_domain::MAX_BULK_IDS
        || memberships.iter().any(|membership| membership.position < 0)
    {
        return Err(RepositoryError::Storage(
            "invalid planning links in undo material".to_owned(),
        ));
    }
    Ok(())
}

fn validate_task_ids(ids: &[TaskId]) -> Result<(), RepositoryError> {
    if ids.len() > junban_domain::MAX_BULK_IDS {
        return Err(RepositoryError::Storage(
            "too many task IDs in serialized material".to_owned(),
        ));
    }
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    if ids.iter().all(|id| seen.insert(*id)) {
        Ok(())
    } else {
        Err(RepositoryError::Storage(
            "duplicate task IDs in serialized material".to_owned(),
        ))
    }
}

/// Validate each task value and require a unique, bulk-bounded identity list.
fn validate_task_collection(tasks: &[Task]) -> Result<(), RepositoryError> {
    for task in tasks {
        validate_task_value(task)?;
    }
    validate_task_ids(&tasks.iter().map(|task| task.id).collect::<Vec<_>>())
}

/// Require two already-unique ID lists to be disjoint and bulk-bounded in union.
fn validate_disjoint_task_id_union(
    left: &[TaskId],
    right: &[TaskId],
) -> Result<(), RepositoryError> {
    let mut seen = std::collections::HashSet::with_capacity(left.len().saturating_add(right.len()));
    seen.extend(left.iter().copied());
    for id in right {
        if !seen.insert(*id) {
            return Err(RepositoryError::Storage(
                "overlapping task IDs in serialized material".to_owned(),
            ));
        }
    }
    if seen.len() > junban_domain::MAX_BULK_IDS {
        return Err(RepositoryError::Storage(
            "too many task IDs in serialized material".to_owned(),
        ));
    }
    Ok(())
}

fn validate_post_image(post: &crate::ops_types::PostImage) -> Result<(), RepositoryError> {
    // Primary affected-task footprint is the unique union of present tasks,
    // absent task IDs, and order keys. Repeated references across those views
    // count once; present/absent identity contradictions are rejected.
    let mut affected = std::collections::HashSet::with_capacity(
        post.tasks
            .len()
            .saturating_add(post.absent_task_ids.len())
            .saturating_add(post.orders.len()),
    );
    for (key, task) in &post.tasks {
        validate_task_value(task)?;
        if key != &task.id.to_string() {
            return Err(RepositoryError::Storage(
                "invalid task post-image key".to_owned(),
            ));
        }
        affected.insert(task.id);
        if affected.len() > junban_domain::MAX_BULK_IDS {
            return Err(RepositoryError::Storage(
                "too many task IDs in serialized material".to_owned(),
            ));
        }
    }
    validate_task_ids(&post.absent_task_ids)?;
    for id in &post.absent_task_ids {
        if post.tasks.contains_key(&id.to_string()) {
            return Err(RepositoryError::Storage(
                "overlapping present and absent task IDs in post-image".to_owned(),
            ));
        }
        affected.insert(*id);
        if affected.len() > junban_domain::MAX_BULK_IDS {
            return Err(RepositoryError::Storage(
                "too many task IDs in serialized material".to_owned(),
            ));
        }
    }
    for key in post.orders.keys() {
        let order_id = TaskId::parse(key).map_err(storage_error)?;
        affected.insert(order_id);
        if affected.len() > junban_domain::MAX_BULK_IDS {
            return Err(RepositoryError::Storage(
                "too many task IDs in serialized material".to_owned(),
            ));
        }
    }
    for (key, comment) in &post.comments {
        validate_comment_value(comment)?;
        if key != &comment.id.to_string() {
            return Err(RepositoryError::Storage(
                "invalid comment post-image key".to_owned(),
            ));
        }
    }
    for (key, project) in &post.projects {
        validate_project_value(project)?;
        if key != &project.id.to_string() {
            return Err(RepositoryError::Storage(
                "invalid project post-image key".to_owned(),
            ));
        }
    }
    for (key, tag) in &post.tags {
        validate_tag_value(tag)?;
        if key != &tag.id.to_string() {
            return Err(RepositoryError::Storage(
                "invalid tag post-image key".to_owned(),
            ));
        }
    }
    for relation in post.relations_present.iter().chain(&post.relations_absent) {
        validate_relation_value(relation)?;
    }
    for (key, reminder) in &post.reminders {
        validate_reminder_value(reminder)?;
        if key != &reminder.map_key() {
            return Err(RepositoryError::Storage(
                "invalid reminder post-image key".to_owned(),
            ));
        }
    }
    for (key, state) in &post.time_slots {
        TimeSlotId::parse(key).map_err(storage_error)?;
        junban_domain::OrderedSlotMembership::new(state.task_ids.clone()).map_err(storage_error)?;
        if state.revision == 0 {
            return Err(RepositoryError::Storage(
                "invalid slot post-image".to_owned(),
            ));
        }
    }
    for (key, state) in &post.time_blocks {
        TimeBlockId::parse(key).map_err(storage_error)?;
        if state.revision == 0 {
            return Err(RepositoryError::Storage(
                "invalid block post-image".to_owned(),
            ));
        }
    }
    Ok(())
}

fn normalize_runtime_state(connection: &Connection) -> Result<(), RepositoryError> {
    connection
        .execute(
            "UPDATE reminder_occurrences
             SET state = CASE WHEN state = 'claimed' THEN 'pending' ELSE state END,
                 claim_term = NULL,
                 claim_expires_at = NULL
             WHERE claim_term IS NOT NULL
                OR claim_expires_at IS NOT NULL
                OR state = 'claimed'",
            [],
        )
        .map_err(storage_error)?;
    connection
        .execute("DELETE FROM reminder_delivery_lease", [])
        .map_err(storage_error)?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct SchemaObject {
    object_type: String,
    name: String,
    table_name: String,
    sql: String,
}

fn assert_canonical_schema(
    connection: &Connection,
    profile_dir: &Path,
) -> Result<(), RepositoryError> {
    let canonical_path = temp_backup_path(profile_dir, "canonical-schema", "sqlite3");
    let mut canonical = Connection::open(&canonical_path).map_err(storage_error)?;
    let canonical_file = StagedFile::new(canonical_path, 0);
    migration::migrate(&mut canonical, profile_dir).map_err(storage_error)?;
    let expected = read_user_schema(&canonical)?;
    let actual = read_user_schema(connection)?;
    drop(canonical);
    drop(canonical_file);
    if actual != expected {
        return Err(RepositoryError::Storage(
            "backup payload schema does not match the canonical schema".into(),
        ));
    }
    Ok(())
}

fn read_user_schema(connection: &Connection) -> Result<Vec<SchemaObject>, RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT type, name, tbl_name, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY type, name",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                table_name: row.get(2)?,
                sql: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn checkpoint_wal(connection: &Connection) -> Result<(), RepositoryError> {
    let (blocked, _log, _checkpointed): (i64, i64, i64) = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(storage_error)?;
    if blocked != 0 {
        return Err(RepositoryError::Storage(
            "wal_checkpoint(TRUNCATE) blocked; cannot stage backup".into(),
        ));
    }
    Ok(())
}

fn assert_integrity(connection: &Connection) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare("PRAGMA integrity_check")
        .map_err(storage_error)?;
    let mut rows = statement.query([]).map_err(storage_error)?;
    let mut messages = Vec::new();
    while let Some(row) = rows.next().map_err(storage_error)? {
        messages.push(row.get::<_, String>(0).map_err(storage_error)?);
    }
    if messages.len() == 1 && messages[0] == "ok" {
        Ok(())
    } else {
        Err(RepositoryError::Storage(format!(
            "integrity_check failed: {}",
            messages.join("; ")
        )))
    }
}

fn assert_foreign_keys_clean(connection: &Connection) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(storage_error)?;
    let mut rows = statement.query([]).map_err(storage_error)?;
    if let Some(row) = rows.next().map_err(storage_error)? {
        let table: String = row.get(0).map_err(storage_error)?;
        let rowid: i64 = row.get(1).map_err(storage_error)?;
        let parent: String = row.get(2).map_err(storage_error)?;
        let fkid: i64 = row.get(3).map_err(storage_error)?;
        return Err(RepositoryError::Storage(format!(
            "foreign_key_check failed: table={table} rowid={rowid} parent={parent} fkid={fkid}"
        )));
    }
    Ok(())
}

fn ensure_backup_dir(profile_dir: &Path) -> Result<(), RepositoryError> {
    ensure_private_dir(&profile_dir.join(BACKUPS_DIR)).map_err(storage_error)
}

fn temp_backup_path(profile_dir: &Path, kind: &str, extension: &str) -> PathBuf {
    let stamp = Timestamp::now().to_string().replace(':', "-");
    let unique = TaskId::new().as_uuid().to_string();
    profile_dir
        .join(BACKUPS_DIR)
        .join(format!(".{kind}-{stamp}-{unique}.{extension}"))
}

fn create_private_new(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true).read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    set_private_file_permissions(path)?;
    Ok(file)
}

pub(crate) fn recovery_candidate_identity(
    path: &Path,
    profile_dir: &Path,
) -> Result<(u64, String, i64, String), RepositoryError> {
    let len = fs::metadata(path).map_err(storage_error)?.len();
    let sha256 = hex_digest(hash_file(path)?);
    let connection = Connection::open(path).map_err(storage_error)?;
    validate_recovery_database(&connection, profile_dir)?;
    let schema_version = read_schema_version(&connection)?;
    let event_epoch: String = connection
        .query_row(
            "SELECT event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    Ok((len, sha256, schema_version, event_epoch))
}

pub(crate) fn validate_recovery_candidate(
    path: &Path,
    profile_dir: &Path,
    expected_len: u64,
    expected_sha256: &str,
    expected_schema_version: i64,
    expected_event_epoch: &str,
) -> Result<(), RepositoryError> {
    if fs::metadata(path).map_err(storage_error)?.len() != expected_len
        || hex_digest(hash_file(path)?) != expected_sha256
    {
        return Err(RepositoryError::Storage(
            "recovery candidate identity does not match cutover marker".to_owned(),
        ));
    }
    let connection = Connection::open(path).map_err(storage_error)?;
    validate_recovery_database(&connection, profile_dir)?;
    let schema_version = read_schema_version(&connection)?;
    let event_epoch: String = connection
        .query_row(
            "SELECT event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if schema_version != expected_schema_version || event_epoch != expected_event_epoch {
        return Err(RepositoryError::Storage(
            "recovery candidate state does not match cutover marker".to_owned(),
        ));
    }
    Ok(())
}

fn validate_recovery_database(
    connection: &Connection,
    profile_dir: &Path,
) -> Result<(), RepositoryError> {
    assert_integrity(connection)?;
    assert_foreign_keys_clean(connection)?;
    assert_canonical_schema(connection, profile_dir)?;
    if read_schema_version(connection)? != CURRENT_SCHEMA_VERSION {
        return Err(RepositoryError::Storage(
            "recovery candidate schema version is unsupported".to_owned(),
        ));
    }
    let _ = read_settings(connection)?;
    validate_authoritative_rows(connection)?;
    Ok(())
}

fn hash_file(path: &Path) -> Result<[u8; 32], RepositoryError> {
    let mut file = File::open(path).map_err(storage_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; COPY_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(storage_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn copy_exact_hashed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    len: u64,
) -> io::Result<[u8; 32]> {
    let mut remaining = len;
    let mut hasher = Sha256::new();
    let mut buffer = [0; COPY_BUFFER_BYTES];
    while remaining > 0 {
        let wanted =
            usize::try_from(remaining.min(COPY_BUFFER_BYTES as u64)).unwrap_or(COPY_BUFFER_BYTES);
        let read = reader.read(&mut buffer[..wanted])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated backup payload",
            ));
        }
        writer.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(hasher.finalize().into())
}

fn hex_digest(bytes: [u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

fn invalid_backup() -> RepositoryError {
    RepositoryError::Validation(junban_domain::ValidationError::Invalid {
        field: "backup",
        reason: "invalid or unsupported backup artifact",
    })
}

fn map_backup_error(error: BackupError) -> RepositoryError {
    match error {
        BackupError::InvalidMagic
        | BackupError::UnsupportedVersion(_)
        | BackupError::ManifestTooLarge(_)
        | BackupError::PayloadTooLarge(_)
        | BackupError::ManifestHashMismatch
        | BackupError::PayloadHashMismatch
        | BackupError::InvalidManifest(_)
        | BackupError::Io(_) => invalid_backup(),
    }
}

#[cfg(test)]
static RESTORE_FAULT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(test)]
static POST_COPY_EPOCH: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
#[cfg(test)]
static FAIL_AFTER_COPY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(test)]
static FAIL_ROLLBACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn record_post_copy_epoch(connection: &Connection) -> Result<(), RepositoryError> {
    let epoch: String = connection
        .query_row(
            "SELECT event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    *POST_COPY_EPOCH.lock().expect("post-copy epoch poisoned") = Some(epoch);
    if FAIL_AFTER_COPY.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return Err(RepositoryError::Storage(
            "injected failure immediately after SQLite copy".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProfileOwner;
    use junban_app::Repository;
    use junban_domain::{
        OperationId, TaskDraft, TaskTitle, frame_backup_envelope, parse_backup_envelope, sha256_hex,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_profile() -> (TempDir, ProfileOwner) {
        let dir = std::env::temp_dir().join(format!(
            "junban-backup-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let owner = ProfileOwner::open(&dir).unwrap();
        (TempDir(dir), owner)
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    #[tokio::test]
    async fn backup_restore_round_trip_rotates_epoch_before_cutover() {
        let _serial = RESTORE_FAULT_TEST_LOCK.lock().await;
        *POST_COPY_EPOCH.lock().expect("post-copy epoch poisoned") = None;
        FAIL_AFTER_COPY.store(false, std::sync::atomic::Ordering::SeqCst);
        let (dir, owner) = temp_profile();
        let repo = owner.repository();
        let now = Timestamp::now();
        let op = OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap();
        let draft = TaskDraft::new(TaskTitle::new("Backup me").unwrap());
        repo.create_task(op, junban_domain::TaskId::new(), draft, now)
            .await
            .unwrap();

        let epoch_before = repo.get_sync_state().await.unwrap().event_epoch;
        let backup = repo.create_backup().await.unwrap();
        assert!(
            fs::read(backup.path())
                .unwrap()
                .starts_with(junban_domain::BACKUP_MAGIC)
        );
        let prepared = repo.prepare_restore(backup).await.unwrap();
        repo.restore_backup(prepared).await.unwrap();
        let epoch_after = repo.get_sync_state().await.unwrap().event_epoch;
        assert_ne!(epoch_before, epoch_after);
        assert_eq!(
            POST_COPY_EPOCH.lock().unwrap().as_deref(),
            Some(epoch_after.as_str()),
            "the copied database already has the rotated epoch at the old post-copy boundary"
        );
        assert!(dir.path().join("junban.sqlite3").exists());
    }

    fn rewrite_backup_payload(dir: &TempDir, backup: &StagedFile, sql: &str) -> StagedFile {
        rewrite_backup_with(dir, backup, |connection| {
            connection.execute_batch(sql).unwrap();
        })
    }

    fn rewrite_backup_with(
        dir: &TempDir,
        backup: &StagedFile,
        rewrite: impl FnOnce(&Connection),
    ) -> StagedFile {
        let bytes = fs::read(backup.path()).unwrap();
        let (mut manifest, payload) = parse_backup_envelope(&bytes).unwrap();
        let sqlite_path = dir.path().join("hostile.sqlite3");
        fs::write(&sqlite_path, payload).unwrap();
        let connection = Connection::open(&sqlite_path).unwrap();
        rewrite(&connection);
        drop(connection);
        let payload = fs::read(&sqlite_path).unwrap();
        manifest.payload_sha256 = sha256_hex(&payload);
        let framed = frame_backup_envelope(&manifest, &payload).unwrap();
        let path = dir
            .path()
            .join(format!("hostile-{}.junban-backup", TaskId::new()));
        fs::write(&path, &framed).unwrap();
        StagedFile::new(path, framed.len() as u64)
    }

    fn sample_task(title: &str) -> Task {
        Task::new(
            TaskId::new(),
            TaskTitle::new(title).unwrap(),
            None,
            Timestamp::now(),
            1,
        )
    }

    fn set_only_undo_inverse(connection: &Connection, inverse: &crate::ops_types::Inverse) {
        let inverse_json = serde_json::to_string(inverse).unwrap();
        let updated = connection
            .execute(
                "UPDATE operation_undo SET inverse_json = ?1",
                rusqlite::params![inverse_json],
            )
            .unwrap();
        assert_eq!(updated, 1, "expected exactly one undo row to rewrite");
    }

    fn set_only_undo_post_image(connection: &Connection, post: &crate::ops_types::PostImage) {
        let post_json = serde_json::to_string(post).unwrap();
        let updated = connection
            .execute(
                "UPDATE operation_undo SET post_image_json = ?1",
                rusqlite::params![post_json],
            )
            .unwrap();
        assert_eq!(updated, 1, "expected exactly one undo row to rewrite");
    }

    #[tokio::test]
    async fn post_copy_failure_has_rotated_candidate_epoch_and_reopens_rolled_back_live_state() {
        let _serial = RESTORE_FAULT_TEST_LOCK.lock().await;
        *POST_COPY_EPOCH.lock().expect("post-copy epoch poisoned") = None;
        FAIL_AFTER_COPY.store(false, std::sync::atomic::Ordering::SeqCst);
        let (dir, owner) = temp_profile();
        let repo = owner.repository();
        let epoch_before = repo.get_sync_state().await.unwrap().event_epoch;
        let backup = repo.create_backup().await.unwrap();

        let later_id = TaskId::new();
        repo.create_task(
            OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
            later_id,
            TaskDraft::new(TaskTitle::new("live after backup").unwrap()),
            Timestamp::now(),
        )
        .await
        .unwrap();
        let prepared = repo.prepare_restore(backup).await.unwrap();
        FAIL_AFTER_COPY.store(true, std::sync::atomic::Ordering::SeqCst);
        let error = repo.restore_backup(prepared).await.unwrap_err();
        assert!(matches!(error, RepositoryError::Storage(_)));
        let copied_epoch = POST_COPY_EPOCH.lock().unwrap().clone().unwrap();
        assert_ne!(copied_epoch, epoch_before);

        drop(repo);
        drop(owner);
        let reopened = ProfileOwner::open(dir.path()).unwrap();
        let reopened_repo = reopened.repository();
        assert_eq!(
            reopened_repo.get_sync_state().await.unwrap().event_epoch,
            epoch_before
        );
        assert!(reopened_repo.get_task(later_id).await.is_ok());
    }

    #[tokio::test]
    async fn apply_and_rollback_failure_persists_recovery_across_owner_reopen() {
        let _serial = RESTORE_FAULT_TEST_LOCK.lock().await;
        FAIL_AFTER_COPY.store(false, std::sync::atomic::Ordering::SeqCst);
        FAIL_ROLLBACK.store(false, std::sync::atomic::Ordering::SeqCst);
        let (dir, owner) = temp_profile();
        let repo = owner.repository();
        let prepared = repo
            .prepare_restore(repo.create_backup().await.unwrap())
            .await
            .unwrap();

        FAIL_AFTER_COPY.store(true, std::sync::atomic::Ordering::SeqCst);
        FAIL_ROLLBACK.store(true, std::sync::atomic::Ordering::SeqCst);
        let error = repo.restore_backup(prepared).await.unwrap_err();
        let RepositoryError::CatastrophicRestore { rollback_path, .. } = error else {
            panic!("expected catastrophic restore error, got {error}");
        };
        assert!(Path::new(&rollback_path).exists());
        let marker = dir.path().join(crate::RECOVERY_REQUIRED_FILE);
        assert!(marker.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        drop(repo);
        drop(owner);
        assert!(matches!(
            ProfileOwner::open(dir.path()),
            Err(crate::OpenError::Database(_))
        ));
        let recovery = crate::RecoveryOwner::open(dir.path()).unwrap();
        assert!(
            marker.exists(),
            "opening recovery must not clear catastrophe"
        );
        drop(recovery);
    }

    #[tokio::test]
    async fn recovery_cutover_reconciles_every_rename_boundary_without_empty_profile() {
        let _serial = RESTORE_FAULT_TEST_LOCK.lock().await;
        for failed_boundary in 0..4 {
            let (dir, owner) = temp_profile();
            let repo = owner.repository();
            let task_id = TaskId::new();
            repo.create_task(
                OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
                task_id,
                TaskDraft::new(TaskTitle::new("survives cutover").unwrap()),
                Timestamp::now(),
            )
            .await
            .unwrap();
            let candidate = repo
                .prepare_restore(repo.create_backup().await.unwrap())
                .await
                .unwrap();
            let candidate_epoch = {
                let connection = Connection::open(candidate.path()).unwrap();
                connection
                    .query_row(
                        "SELECT event_epoch FROM app_state WHERE singleton = 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .unwrap()
            };
            drop(repo);
            drop(owner);

            // Force all three old-file rename boundaries on every platform. These are
            // rollback artifacts only; recovery never opens them as SQLite sidecars.
            fs::write(
                dir.path().join(format!("{}-wal", crate::DATABASE_FILE)),
                b"old wal",
            )
            .unwrap();
            fs::write(
                dir.path().join(format!("{}-shm", crate::DATABASE_FILE)),
                b"old shm",
            )
            .unwrap();
            let result =
                crate::recovery_replace_database_with(dir.path(), &candidate, |boundary| {
                    if boundary == failed_boundary {
                        Err(io::Error::other("injected process death boundary"))
                    } else {
                        Ok(())
                    }
                });
            assert!(result.is_err(), "boundary {failed_boundary} did not fault");
            let marker = dir.path().join(crate::RECOVERY_CUTOVER_FILE);
            assert!(marker.exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            assert!(matches!(
                ProfileOwner::open(dir.path()),
                Err(crate::OpenError::Database(_))
            ));

            let recovery = crate::RecoveryOwner::open(dir.path()).unwrap();
            assert!(!dir.path().join(crate::RECOVERY_CUTOVER_FILE).exists());
            assert!(dir.path().join(crate::DATABASE_FILE).exists());
            drop(recovery);
            let reopened = ProfileOwner::open(dir.path()).unwrap();
            let reopened_repo = reopened.repository();
            assert_eq!(
                reopened_repo.get_sync_state().await.unwrap().event_epoch,
                candidate_epoch
            );
            assert_eq!(
                reopened_repo
                    .get_task(task_id)
                    .await
                    .unwrap()
                    .title
                    .as_str(),
                "survives cutover"
            );
        }
    }

    #[tokio::test]
    async fn restore_preflight_rejects_noncanonical_user_schema_without_mutating_live() {
        let attacks = [
            "CREATE TRIGGER hostile AFTER INSERT ON tasks BEGIN DELETE FROM tasks; END;",
            "CREATE TABLE hostile(value TEXT);",
            "DROP INDEX idx_tasks_status;",
            "PRAGMA writable_schema=ON; UPDATE sqlite_schema SET sql = sql || ' ' WHERE type='table' AND name='tasks'; PRAGMA writable_schema=OFF;",
        ];
        for attack in attacks {
            let (dir, owner) = temp_profile();
            let repo = owner.repository();
            let epoch_before = repo.get_sync_state().await.unwrap().event_epoch;
            let backup = repo.create_backup().await.unwrap();
            let hostile = rewrite_backup_payload(&dir, &backup, attack);
            let error = repo.prepare_restore(hostile).await.unwrap_err();
            assert!(
                matches!(error, RepositoryError::Validation(_)),
                "{attack}: {error}"
            );
            assert_eq!(
                repo.get_sync_state().await.unwrap().event_epoch,
                epoch_before
            );
        }
    }

    #[tokio::test]
    async fn restore_preflight_rejects_domain_invalid_and_malformed_serialized_rows() {
        let attacks = [
            "PRAGMA ignore_check_constraints=ON; UPDATE tasks SET title = '';",
            "UPDATE events SET event_json = '{}';",
            "UPDATE operation_receipts SET response_json = '{}';",
            "UPDATE operation_undo SET inverse_json = '{}';",
        ];
        for attack in attacks {
            let (dir, owner) = temp_profile();
            let repo = owner.repository();
            repo.create_task(
                OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
                TaskId::new(),
                TaskDraft::new(TaskTitle::new("valid before hostile rewrite").unwrap()),
                Timestamp::now(),
            )
            .await
            .unwrap();
            let epoch_before = repo.get_sync_state().await.unwrap().event_epoch;
            let backup = repo.create_backup().await.unwrap();
            let hostile = rewrite_backup_payload(&dir, &backup, attack);
            assert!(
                matches!(
                    repo.prepare_restore(hostile).await,
                    Err(RepositoryError::Validation(_))
                ),
                "hostile row reached restore: {attack}"
            );
            assert_eq!(
                repo.get_sync_state().await.unwrap().event_epoch,
                epoch_before
            );
        }
    }

    #[tokio::test]
    async fn restore_rejects_truncated_envelope() {
        let (dir, owner) = temp_profile();
        let path = dir.path().join("backups").join("bad.junban-backup");
        ensure_private_dir(path.parent().unwrap()).unwrap();
        fs::write(&path, b"JNBK").unwrap();
        let upload = StagedFile::new(path, 4);
        let err = owner
            .repository()
            .prepare_restore(upload)
            .await
            .unwrap_err();
        assert!(matches!(err, RepositoryError::Validation(_)));
    }

    #[tokio::test]
    async fn restore_preflight_rejects_restore_tasks_inverse_over_bulk_ceiling() {
        let (dir, owner) = temp_profile();
        let repo = owner.repository();
        repo.create_task(
            OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("seed undo row").unwrap()),
            Timestamp::now(),
        )
        .await
        .unwrap();
        let epoch_before = repo.get_sync_state().await.unwrap().event_epoch;
        let backup = repo.create_backup().await.unwrap();

        let tasks = (0..=junban_domain::MAX_BULK_IDS)
            .map(|index| sample_task(&format!("hostile-{index}")))
            .collect::<Vec<_>>();
        assert_eq!(tasks.len(), junban_domain::MAX_BULK_IDS + 1);
        let inverse = crate::ops_types::restore_tasks_inverse(tasks, Vec::new());
        let hostile = rewrite_backup_with(&dir, &backup, |connection| {
            set_only_undo_inverse(connection, &inverse);
        });

        assert!(
            matches!(
                repo.prepare_restore(hostile).await,
                Err(RepositoryError::Validation(_))
            ),
            "501-task RestoreTasks inverse must fail restore preflight"
        );
        assert_eq!(
            repo.get_sync_state().await.unwrap().event_epoch,
            epoch_before,
            "rejected bulk undo must not enter maintenance"
        );
    }

    #[tokio::test]
    async fn restore_preflight_rejects_duplicate_and_overlapping_undo_task_identities() {
        let (dir, owner) = temp_profile();
        let repo = owner.repository();
        repo.create_task(
            OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("seed undo row").unwrap()),
            Timestamp::now(),
        )
        .await
        .unwrap();
        let epoch_before = repo.get_sync_state().await.unwrap().event_epoch;
        let backup = repo.create_backup().await.unwrap();

        let duplicate_id = TaskId::new();
        let duplicate_task = Task::new(
            duplicate_id,
            TaskTitle::new("duplicate").unwrap(),
            None,
            Timestamp::now(),
            1,
        );
        let duplicate_inverse = crate::ops_types::restore_tasks_inverse(
            vec![duplicate_task.clone(), duplicate_task],
            Vec::new(),
        );
        let hostile_duplicate = rewrite_backup_with(&dir, &backup, |connection| {
            set_only_undo_inverse(connection, &duplicate_inverse);
        });
        assert!(
            matches!(
                repo.prepare_restore(hostile_duplicate).await,
                Err(RepositoryError::Validation(_))
            ),
            "duplicate RestoreTasks identities must fail preflight"
        );

        let shared = TaskId::new();
        let source = Task::new(
            shared,
            TaskTitle::new("source").unwrap(),
            None,
            Timestamp::now(),
            1,
        );
        let overlap_inverse = crate::ops_types::Inverse::ReverseCompletion {
            sources: vec![source],
            generated_ids: vec![shared],
            source_reminders: Vec::new(),
        };
        let hostile_overlap = rewrite_backup_with(&dir, &backup, |connection| {
            set_only_undo_inverse(connection, &overlap_inverse);
        });
        assert!(
            matches!(
                repo.prepare_restore(hostile_overlap).await,
                Err(RepositoryError::Validation(_))
            ),
            "ReverseCompletion source/generated overlap must fail preflight"
        );

        let present = sample_task("present");
        let mut post = crate::ops_types::PostImage::default();
        post.tasks.insert(present.id.to_string(), present.clone());
        post.absent_task_ids.push(present.id);
        let hostile_post = rewrite_backup_with(&dir, &backup, |connection| {
            set_only_undo_post_image(connection, &post);
        });
        assert!(
            matches!(
                repo.prepare_restore(hostile_post).await,
                Err(RepositoryError::Validation(_))
            ),
            "present/absent post-image contradiction must fail preflight"
        );

        assert_eq!(
            repo.get_sync_state().await.unwrap().event_epoch,
            epoch_before
        );
    }
}
