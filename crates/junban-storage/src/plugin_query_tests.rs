use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use junban_app::{PluginQueryRepository, plugin_task_reply_bytes};
use junban_plugin_sdk::private_body_types::{CatalogQuery, TaskQuery};
use rusqlite::params;

use super::*;

const EPOCH: &str = "00112233-4455-6677-e899-aabbccddeeff";
const NOW: u64 = 1_800_000_000;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "junban-plugin-query-{}-{}-{sequence}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    directory: TempDir,
    database_path: std::path::PathBuf,
    connection: Connection,
    keys: PluginQueryKeyring,
}

impl Fixture {
    fn new() -> Self {
        let directory = TempDir::new();
        let database_path = directory.path().join("junban.sqlite3");
        let connection = crate::open_connection(&database_path).unwrap();
        connection
            .execute(
                "UPDATE app_state SET global_revision = 1, event_epoch = ?1 WHERE singleton = 1",
                [EPOCH],
            )
            .unwrap();
        let mut keys = PluginQueryKeyring::default();
        keys.refresh(directory.path(), NOW).unwrap();
        Self {
            directory,
            database_path,
            connection,
            keys,
        }
    }

    fn set_revision(&self, revision: u64) {
        self.connection
            .execute(
                "UPDATE app_state SET global_revision = ?1 WHERE singleton = 1",
                [i64::try_from(revision).unwrap()],
            )
            .unwrap();
    }

    fn insert_task(&self, seed: &TaskSeed<'_>) {
        let terminal = if seed.status == "pending" {
            None
        } else {
            Some("2026-01-15T12:00:00Z")
        };
        let (completed_at, cancelled_at) = match seed.status {
            "completed" => (terminal, None),
            "cancelled" => (None, terminal),
            _ => (None, None),
        };
        self.connection
            .execute(
                "INSERT INTO tasks(
                         id, title, description, due_date, status, priority, project_id,
                         section_id, parent_id, completed_at, cancelled_at, created_at,
                         updated_at, revision
                     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    seed.id,
                    seed.title,
                    seed.description,
                    seed.due_date,
                    seed.status,
                    seed.priority,
                    seed.project_id,
                    seed.section_id,
                    seed.parent_id,
                    completed_at,
                    cancelled_at,
                    "2026-01-01T12:00:00Z",
                    "2026-01-15T12:00:00Z",
                    i64::try_from(seed.revision).unwrap(),
                ],
            )
            .unwrap();
    }

    fn insert_project(&self, id: &str, name: &str) {
        self.connection
            .execute(
                "INSERT INTO projects(id,name,color,created_at,updated_at)
                     VALUES (?1,?2,'#112233','2026-01-01T12:00:00Z','2026-01-01T12:00:00Z')",
                params![id, name],
            )
            .unwrap();
    }

    fn insert_tag(&self, id: &str, name: &str) {
        self.connection
            .execute(
                "INSERT INTO tags(id,name,name_normalized,color,created_at,updated_at)
                     VALUES (?1,?2,?3,'#334455','2026-01-01T12:00:00Z','2026-01-01T12:00:00Z')",
                params![id, name, name.to_lowercase()],
            )
            .unwrap();
    }
}

struct TaskSeed<'a> {
    id: &'a str,
    title: &'a str,
    description: &'a str,
    due_date: Option<&'a str>,
    status: &'a str,
    priority: Option<i64>,
    project_id: Option<&'a str>,
    section_id: Option<&'a str>,
    parent_id: Option<&'a str>,
    revision: u64,
}

fn basic_task(id: &str) -> TaskSeed<'_> {
    TaskSeed {
        id,
        title: "Task",
        description: "",
        due_date: None,
        status: "pending",
        priority: None,
        project_id: None,
        section_id: None,
        parent_id: None,
        revision: 1,
    }
}

fn task_query(limit: u16) -> TaskQuery {
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
        limit,
    }
}

fn catalog_query(limit: u16) -> CatalogQuery {
    CatalogQuery {
        cursor: None,
        limit,
    }
}

fn normalized_task(request: TaskQuery) -> PluginTaskQuery {
    PluginTaskQuery::normalize(request).unwrap()
}

fn normalized_catalog(request: CatalogQuery) -> PluginCatalogQuery {
    PluginCatalogQuery::normalize(request).unwrap()
}

fn hex_string(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| [hex_digit(byte >> 4), hex_digit(byte & 0x0f)])
        .collect()
}

fn resign(keys: &PluginQueryKeyring, decoded: &mut [u8]) {
    let mac = keys.sign(&decoded[..CURSOR_AUTHENTICATED_BYTES]).unwrap();
    decoded[CURSOR_AUTHENTICATED_BYTES..].copy_from_slice(&mac);
}

#[test]
fn uuid_codec_preserves_all_octets_without_variant_or_version_rules() {
    for value in [
        "00000000-0000-0000-0000-000000000000",
        "00112233-4455-6677-e899-aabbccddeeff",
        "00112233-4455-f677-8899-aabbccddeeff",
    ] {
        let bytes = canonical_uuid_bytes(value).unwrap();
        assert_eq!(canonical_uuid_string(&bytes).unwrap(), value);
    }
    assert!(canonical_uuid_bytes("00112233-4455-6677-E899-aabbccddeeff").is_err());
}

#[test]
fn base64_codec_is_strict_and_cursor_length_is_fixed() {
    let input = [0xabu8; CURSOR_ENVELOPE_BYTES];
    let encoded = base64url_encode(&input);
    assert_eq!(encoded.len(), CURSOR_TEXT_BYTES);
    assert_eq!(base64url_decode(&encoded).unwrap(), input);
    assert!(base64url_decode(&(encoded + "=")).is_err());
}

#[test]
fn normalized_query_hash_has_fixed_domain_kind_length_and_sdk_body_goldens() {
    let task = normalized_task(task_query(10));
    let project = normalized_catalog(catalog_query(10));
    let task_hash =
        normalized_query_hash(QueryKind::Task, &plugin_task_query_bytes(&task).unwrap()).unwrap();
    let project_hash = normalized_query_hash(
        QueryKind::Project,
        &plugin_catalog_query_bytes(&project, true).unwrap(),
    )
    .unwrap();
    let tag_hash = normalized_query_hash(
        QueryKind::Tag,
        &plugin_catalog_query_bytes(&project, false).unwrap(),
    )
    .unwrap();
    assert_eq!(
        hex_string(&task_hash),
        "3950ba3e7be1513bbfba96251d3546cf3876feb6d4d4b147fadc36a544cbe6c6"
    );
    assert_eq!(
        hex_string(&project_hash),
        "7d5020fa1eda405f60b5ced2263ff3a9f578e36e7db711118470c6fd2b027787"
    );
    assert_eq!(
        hex_string(&tag_hash),
        "9f8df02473dcd754db8af47d7e9b6db2daf51b273523b65aaab2011e73419e65"
    );
}

#[test]
fn cursor_rejects_every_tamper_malformed_encoding_and_authenticated_mismatch() {
    let fixture = Fixture::new();
    let hash = [0x5a; 32];
    let cursor = encode_cursor(
        &fixture.keys,
        QueryKind::Task,
        NOW,
        1,
        EPOCH,
        hash,
        "00000000-0000-0000-e000-000000000001",
    )
    .unwrap();
    assert_eq!(cursor.len(), CURSOR_TEXT_BYTES);
    let authority = decode_cursor(&fixture.keys, &cursor, QueryKind::Task, hash, NOW).unwrap();
    assert_eq!(authority.last_id, "00000000-0000-0000-e000-000000000001");

    let decoded = base64url_decode(&cursor).unwrap();
    for index in 0..decoded.len() {
        let mut tampered = decoded.clone();
        tampered[index] ^= 1;
        assert_eq!(
            decode_cursor(
                &fixture.keys,
                &base64url_encode(&tampered),
                QueryKind::Task,
                hash,
                NOW,
            ),
            Err(PluginQueryError::InvalidInput)
        );
    }
    for malformed in [
        String::new(),
        "A".repeat(CURSOR_TEXT_BYTES),
        format!("{cursor}="),
        "!".repeat(CURSOR_TEXT_BYTES),
        "A".repeat(CURSOR_INPUT_BYTES_MAX + 1),
    ] {
        assert_eq!(
            decode_cursor(&fixture.keys, &malformed, QueryKind::Task, hash, NOW),
            Err(PluginQueryError::InvalidInput)
        );
    }
    assert_eq!(
        decode_cursor(&fixture.keys, &cursor, QueryKind::Project, hash, NOW),
        Err(PluginQueryError::InvalidInput)
    );
    assert_eq!(
        decode_cursor(&fixture.keys, &cursor, QueryKind::Task, [0x6b; 32], NOW),
        Err(PluginQueryError::InvalidInput)
    );

    for (offset, value) in [(0, 2), (1, 9)] {
        let mut authenticated = decoded.clone();
        authenticated[offset] = value;
        resign(&fixture.keys, &mut authenticated);
        assert_eq!(
            decode_cursor(
                &fixture.keys,
                &base64url_encode(&authenticated),
                QueryKind::Task,
                hash,
                NOW,
            ),
            Err(PluginQueryError::InvalidInput)
        );
    }
}

#[test]
fn cursor_time_and_integer_boundaries_are_checked_without_overflow() {
    let fixture = Fixture::new();
    let hash = [7; 32];
    let cursor = encode_cursor(
        &fixture.keys,
        QueryKind::Task,
        NOW,
        i64::MAX as u64,
        EPOCH,
        hash,
        "00000000-0000-f000-8000-000000000001",
    )
    .unwrap();
    assert!(decode_cursor(&fixture.keys, &cursor, QueryKind::Task, hash, NOW).is_ok());
    assert_eq!(
        decode_cursor(
            &fixture.keys,
            &cursor,
            QueryKind::Task,
            hash,
            NOW + CURSOR_TTL_SECONDS,
        ),
        Err(PluginQueryError::CursorStale)
    );
    assert_eq!(
        decode_cursor(&fixture.keys, &cursor, QueryKind::Task, hash, NOW - 1),
        Err(PluginQueryError::CursorStale)
    );
    assert_eq!(
        encode_cursor(
            &fixture.keys,
            QueryKind::Task,
            u64::MAX,
            1,
            EPOCH,
            hash,
            "00000000-0000-0000-0000-000000000001",
        ),
        Err(PluginQueryError::InvalidInput)
    );

    let mut oversized_revision = base64url_decode(&cursor).unwrap();
    oversized_revision[18..26].copy_from_slice(&(i64::MAX as u64 + 1).to_be_bytes());
    resign(&fixture.keys, &mut oversized_revision);
    assert_eq!(
        decode_cursor(
            &fixture.keys,
            &base64url_encode(&oversized_revision),
            QueryKind::Task,
            hash,
            NOW,
        ),
        Err(PluginQueryError::InvalidInput)
    );
}

#[test]
fn profile_key_rotation_has_one_bounded_fallback_and_restart_fails_closed() {
    let mut fixture = Fixture::new();
    let hash = [9; 32];
    let old = encode_cursor(
        &fixture.keys,
        QueryKind::Task,
        NOW,
        1,
        EPOCH,
        hash,
        "00000000-0000-0000-0000-000000000001",
    )
    .unwrap();
    let secret_path = fixture
        .directory
        .path()
        .join(junban_domain::AI_SECRETS_FILE);
    fs::remove_file(&secret_path).unwrap();
    fixture
        .keys
        .refresh(fixture.directory.path(), NOW + 10)
        .unwrap();
    assert!(
        decode_cursor(&fixture.keys, &old, QueryKind::Task, hash, NOW + 10).is_ok(),
        "the one prior key remains bounded by the cursor TTL"
    );

    let mut restarted = PluginQueryKeyring::default();
    restarted
        .refresh(fixture.directory.path(), NOW + 10)
        .unwrap();
    assert_eq!(
        decode_cursor(&restarted, &old, QueryKind::Task, hash, NOW + 10),
        Err(PluginQueryError::InvalidInput)
    );

    let middle = encode_cursor(
        &fixture.keys,
        QueryKind::Task,
        NOW + 10,
        1,
        EPOCH,
        hash,
        "00000000-0000-0000-0000-000000000001",
    )
    .unwrap();
    fs::remove_file(&secret_path).unwrap();
    fixture
        .keys
        .refresh(fixture.directory.path(), NOW + 20)
        .unwrap();
    assert_eq!(
        decode_cursor(&fixture.keys, &old, QueryKind::Task, hash, NOW + 20),
        Err(PluginQueryError::InvalidInput)
    );
    assert!(decode_cursor(&fixture.keys, &middle, QueryKind::Task, hash, NOW + 20).is_ok());

    let other = Fixture::new();
    assert_eq!(
        decode_cursor(&other.keys, &middle, QueryKind::Task, hash, NOW + 20),
        Err(PluginQueryError::InvalidInput)
    );
}

#[test]
fn key_load_failure_is_scrubbed_and_does_not_mutate_the_failed_file() {
    let mut fixture = Fixture::new();
    let secret_path = fixture
        .directory
        .path()
        .join(junban_domain::AI_SECRETS_FILE);
    fs::write(&secret_path, b"{malformed").unwrap();
    let before = Sha256::digest(fs::read(&secret_path).unwrap());
    let error = fixture
        .keys
        .refresh(fixture.directory.path(), NOW + 1)
        .unwrap_err();
    assert_eq!(error, PluginQueryError::Unavailable);
    assert_eq!(format!("{error}"), "ordinary plugin query is unavailable");
    let after = Sha256::digest(fs::read(&secret_path).unwrap());
    assert!(before == after);
}

#[test]
fn cursor_hmac_domain_cannot_be_confused_with_ai_secret_receipt_verifier() {
    let fixture = Fixture::new();
    let active = fixture.keys.active.as_ref().unwrap();
    let body = b"purpose-separation-probe";
    let cursor_mac = active.mac(body).unwrap();
    let receipt_store = AiSecretStore::load(fixture.directory.path()).unwrap();
    let receipt = receipt_store
        .receipt_verifier(&junban_app::AiSecretBytes::new("purpose-separation-probe").unwrap())
        .unwrap();
    assert!(hex_string(&cursor_mac) != receipt);
}

#[test]
fn task_project_and_tag_pages_use_canonical_id_keysets_without_uuid_rewriting() {
    let fixture = Fixture::new();
    fixture.set_revision(9);
    let ids = [
        "00000000-0000-0000-0000-000000000000",
        "00000000-0000-0000-e000-000000000001",
        "00000000-0000-f000-8000-000000000001",
    ];
    for id in ids {
        fixture.insert_task(&basic_task(id));
        fixture.insert_project(id, &format!("Project {id}"));
        fixture.insert_tag(id, &format!("Tag{id}"));
    }

    let mut cursor = None;
    let mut task_ids = Vec::new();
    loop {
        let mut request = task_query(1);
        request.cursor = cursor;
        let page = query_tasks_at(
            &fixture.connection,
            &fixture.keys,
            normalized_task(request),
            NOW,
        )
        .unwrap();
        assert_eq!(page.revision, 9);
        task_ids.extend(page.items.into_iter().map(|item| item.id));
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(task_ids, ids);

    let mut request = catalog_query(2);
    let first = query_projects_at(
        &fixture.connection,
        &fixture.keys,
        normalized_catalog(request.clone()),
        NOW,
    )
    .unwrap();
    assert_eq!(
        first
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        &ids[..2]
    );
    request.cursor = first.next_cursor;
    let second = query_projects_at(
        &fixture.connection,
        &fixture.keys,
        normalized_catalog(request),
        NOW,
    )
    .unwrap();
    assert_eq!(second.items[0].id, ids[2]);
    assert!(second.next_cursor.is_none());

    let tags = query_tags_at(
        &fixture.connection,
        &fixture.keys,
        normalized_catalog(catalog_query(100)),
        NOW,
    )
    .unwrap();
    assert_eq!(
        tags.items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        ids
    );
}

#[test]
fn task_filters_are_exact_all_of_bounded_and_literal() {
    let fixture = Fixture::new();
    fixture.set_revision(20);
    let project = "10000000-0000-0000-0000-000000000001";
    let other_project = "10000000-0000-0000-0000-000000000002";
    let section = "20000000-0000-0000-0000-000000000001";
    let parent = "30000000-0000-0000-0000-000000000001";
    let target = "30000000-0000-0000-0000-000000000002";
    let other = "30000000-0000-0000-0000-000000000003";
    let tag_a = "40000000-0000-0000-0000-000000000001";
    let tag_b = "40000000-0000-0000-0000-000000000002";
    fixture.insert_project(project, "One");
    fixture.insert_project(other_project, "Two");
    fixture.insert_tag(tag_a, "Alpha");
    fixture.insert_tag(tag_b, "Beta");
    fixture
        .connection
        .execute(
            "INSERT INTO sections(id,project_id,name,created_at,updated_at)
                 VALUES (?1,?2,'Section','2026-01-01T12:00:00Z','2026-01-01T12:00:00Z')",
            params![section, project],
        )
        .unwrap();
    fixture.insert_task(&basic_task(parent));
    fixture.insert_task(&TaskSeed {
        id: target,
        title: "Literal %_ Needle",
        description: "Description Exact",
        due_date: Some("2026-01-15"),
        status: "completed",
        priority: Some(2),
        project_id: Some(project),
        section_id: Some(section),
        parent_id: Some(parent),
        revision: 2,
    });
    fixture.insert_task(&TaskSeed {
        id: other,
        title: "literal wildcard other",
        description: "description exact",
        due_date: Some("2026-02-01"),
        status: "pending",
        priority: Some(1),
        project_id: Some(other_project),
        section_id: None,
        parent_id: None,
        revision: 3,
    });
    fixture
        .connection
        .execute(
            "INSERT INTO task_tags(task_id,tag_id) VALUES (?1,?2), (?1,?3)",
            params![target, tag_a, tag_b],
        )
        .unwrap();
    fixture
        .connection
        .execute(
            "INSERT INTO task_tags(task_id,tag_id) VALUES (?1,?2)",
            params![other, tag_a],
        )
        .unwrap();

    let mut request = task_query(100);
    request.task_id = Some(target.into());
    request.project_id = Some(project.into());
    request.section_id = Some(section.into());
    request.parent_id = Some(parent.into());
    request.tag_ids = vec![tag_b.into(), tag_a.into(), tag_b.into()];
    request.statuses = vec![TaskStatus::Completed];
    request.priorities = vec![Priority::P2];
    request.due_from = Some("2026-01-01".into());
    request.due_before = Some("2026-02-01".into());
    request.search = Some("%_".into());
    let page = query_tasks_at(
        &fixture.connection,
        &fixture.keys,
        normalized_task(request),
        NOW,
    )
    .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].id, target);
    assert_eq!(page.items[0].tag_ids, [tag_a, tag_b]);

    let mut case_sensitive = task_query(100);
    case_sensitive.search = Some("literal %_".into());
    assert!(
        query_tasks_at(
            &fixture.connection,
            &fixture.keys,
            normalized_task(case_sensitive),
            NOW,
        )
        .unwrap()
        .items
        .is_empty()
    );
}

#[test]
fn filtered_continuation_requires_the_exact_normalized_query() {
    let fixture = Fixture::new();
    for id in [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
    ] {
        fixture.insert_task(&basic_task(id));
    }
    let mut first_request = task_query(1);
    first_request.statuses = vec![TaskStatus::Pending];
    let first = query_tasks_at(
        &fixture.connection,
        &fixture.keys,
        normalized_task(first_request),
        NOW,
    )
    .unwrap();
    let mut changed = task_query(1);
    changed.statuses = vec![TaskStatus::Completed];
    changed.cursor = first.next_cursor;
    assert_eq!(
        query_tasks_at(
            &fixture.connection,
            &fixture.keys,
            normalized_task(changed),
            NOW,
        ),
        Err(PluginQueryError::InvalidInput)
    );
}

#[test]
fn invalid_stored_row_fails_the_complete_page_without_partial_success() {
    let fixture = Fixture::new();
    fixture.insert_task(&basic_task("00000000-0000-0000-0000-000000000001"));
    fixture.insert_task(&TaskSeed {
        id: "00000000-0000-0000-0000-000000000002",
        title: "Invalid",
        description: &"x".repeat(10_001),
        due_date: None,
        status: "pending",
        priority: None,
        project_id: None,
        section_id: None,
        parent_id: None,
        revision: 1,
    });
    assert_eq!(
        query_tasks_at(
            &fixture.connection,
            &fixture.keys,
            normalized_task(task_query(100)),
            NOW,
        ),
        Err(PluginQueryError::Unavailable)
    );
}

#[test]
fn revision_and_event_epoch_drift_map_only_to_cursor_stale() {
    let fixture = Fixture::new();
    fixture.insert_task(&basic_task("00000000-0000-0000-0000-000000000001"));
    fixture.insert_task(&basic_task("00000000-0000-0000-0000-000000000002"));
    let first = query_tasks_at(
        &fixture.connection,
        &fixture.keys,
        normalized_task(task_query(1)),
        NOW,
    )
    .unwrap();
    let cursor = first.next_cursor.unwrap();
    fixture.set_revision(2);
    let mut continuation = task_query(1);
    continuation.cursor = Some(cursor.clone());
    assert_eq!(
        query_tasks_at(
            &fixture.connection,
            &fixture.keys,
            normalized_task(continuation.clone()),
            NOW,
        ),
        Err(PluginQueryError::CursorStale)
    );
    fixture.set_revision(1);
    fixture
            .connection
            .execute(
                "UPDATE app_state SET event_epoch = 'ffffffff-ffff-ffff-ffff-ffffffffffff' WHERE singleton = 1",
                [],
            )
            .unwrap();
    assert_eq!(
        query_tasks_at(
            &fixture.connection,
            &fixture.keys,
            normalized_task(continuation),
            NOW,
        ),
        Err(PluginQueryError::CursorStale)
    );
}

#[test]
fn one_read_transaction_keeps_rows_and_sampled_authority_consistent_with_writer() {
    let fixture = Fixture::new();
    fixture.insert_task(&basic_task("00000000-0000-0000-0000-000000000001"));
    let writer = Connection::open(&fixture.database_path).unwrap();
    writer
        .busy_timeout(std::time::Duration::from_secs(1))
        .unwrap();
    let page = query_tasks_at_with_after_sample(
            &fixture.connection,
            &fixture.keys,
            normalized_task(task_query(100)),
            NOW,
            || {
                writer
                    .execute_batch(
                        "BEGIN IMMEDIATE;
                         INSERT INTO tasks(id,title,description,status,created_at,updated_at,revision)
                         VALUES ('00000000-0000-0000-0000-000000000002','New','','pending',
                                 '2026-01-01T12:00:00Z','2026-01-01T12:00:00Z',2);
                         UPDATE app_state SET global_revision = 2 WHERE singleton = 1;
                         COMMIT;",
                    )
                    .unwrap();
            },
        )
        .unwrap();
    assert_eq!(page.revision, 1);
    assert_eq!(page.items.len(), 1);
    let later = query_tasks_at(
        &fixture.connection,
        &fixture.keys,
        normalized_task(task_query(100)),
        NOW,
    )
    .unwrap();
    assert_eq!(later.revision, 2);
    assert_eq!(later.items.len(), 2);
}

fn valid_view(index: usize, description_len: usize) -> TaskView {
    TaskView {
        id: format!("00000000-0000-0000-0000-{index:012x}"),
        title: "Sized task".into(),
        description: "x".repeat(description_len),
        status: TaskStatus::Pending,
        priority: None,
        due_date: None,
        due_time: None,
        deadline: None,
        someday: false,
        estimated_minutes: None,
        actual_minutes: None,
        dread: None,
        project_id: None,
        section_id: None,
        parent_id: None,
        tag_ids: Vec::new(),
        sort_order: 0,
        recurrence_rule: None,
        remind_at: None,
        recurrence_anchor_day: None,
        created_at: "2026-01-01T12:00:00Z".into(),
        updated_at: "2026-01-01T12:00:00Z".into(),
        revision: 1,
    }
}

#[test]
fn complete_sdk_reply_accounting_is_exact_greedy_and_never_truncates() {
    let fixture = Fixture::new();
    let hash = [3; 32];
    let mut exact_items = Vec::new();
    for index in 0..100 {
        exact_items.push(valid_view(index, 0));
        let base = plugin_task_reply_bytes(TaskPage {
            items: exact_items.clone(),
            next_cursor: None,
            revision: 1,
        })
        .unwrap()
        .len();
        if base <= PLUGIN_QUERY_REPLY_BYTES_MAX
            && PLUGIN_QUERY_REPLY_BYTES_MAX - base <= exact_items.len() * 10_000
        {
            let mut remaining = PLUGIN_QUERY_REPLY_BYTES_MAX - base;
            for item in &mut exact_items {
                let amount = remaining.min(10_000);
                item.description = "x".repeat(amount);
                remaining -= amount;
            }
            assert_eq!(remaining, 0);
            break;
        }
    }
    let exact = build_task_page(
        &fixture.keys,
        exact_items.clone(),
        1,
        EPOCH,
        hash,
        100,
        NOW,
        PLUGIN_QUERY_REPLY_BYTES_MAX,
    )
    .unwrap();
    assert_eq!(
        plugin_task_reply_bytes(exact).unwrap().len(),
        PLUGIN_QUERY_REPLY_BYTES_MAX
    );

    let one = vec![valid_view(1, 10_000)];
    let one_size = plugin_task_reply_bytes(TaskPage {
        items: one.clone(),
        next_cursor: None,
        revision: 1,
    })
    .unwrap()
    .len();
    assert_eq!(
        build_task_page(&fixture.keys, one, 1, EPOCH, hash, 1, NOW, one_size - 1,),
        Err(PluginQueryError::OperationTooLarge)
    );

    let candidates = (0..100)
        .map(|index| valid_view(index, 10_000))
        .collect::<Vec<_>>();
    let first = build_task_page(
        &fixture.keys,
        candidates.clone(),
        1,
        EPOCH,
        hash,
        100,
        NOW,
        PLUGIN_QUERY_REPLY_BYTES_MAX,
    )
    .unwrap();
    assert!(first.items.len() < candidates.len());
    assert!(first.next_cursor.is_some());
    assert!(plugin_task_reply_bytes(first.clone()).unwrap().len() <= PLUGIN_QUERY_REPLY_BYTES_MAX);
    let mut all = first.items;
    while all.len() < candidates.len() {
        let page = build_task_page(
            &fixture.keys,
            candidates[all.len()..].to_vec(),
            1,
            EPOCH,
            hash,
            100,
            NOW,
            PLUGIN_QUERY_REPLY_BYTES_MAX,
        )
        .unwrap();
        assert!(!page.items.is_empty());
        all.extend(page.items);
    }
    assert_eq!(all, candidates);
}

#[tokio::test]
async fn profile_secret_file_is_created_lazily_by_first_ordinary_query() {
    let directory = TempDir::new();
    let secret_path = directory.path().join(junban_domain::AI_SECRETS_FILE);
    let owner = crate::ProfileOwner::open(directory.path()).unwrap();
    assert!(!secret_path.exists());
    let page = owner
        .repository()
        .query_plugin_tags(normalized_catalog(catalog_query(1)))
        .await
        .unwrap();
    assert!(page.items.is_empty());
    assert!(secret_path.exists());
}
