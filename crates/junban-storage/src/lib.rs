//! SQLite persistence with one profile owner and one dedicated connection thread.

use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};

use fs4::FileExt;
use jiff::{Timestamp, civil::Date};
use junban_app::{
    CommittedMutation, RepositoryError, RepositoryFuture, TaskEvent, TaskEventKind, TaskList,
    TaskRepository,
};
use junban_domain::{OperationId, Task, TaskId, TaskStatus, TaskTitle};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::Serialize;
use thiserror::Error;
use tokio::sync::oneshot;

const DATABASE_FILE: &str = "junban.sqlite3";
const LOCK_FILE: &str = "profile.lock";
const BUSY_TIMEOUT: Duration = Duration::from_millis(2_500);

#[derive(Debug, Error)]
pub enum OpenError {
    #[error("profile is already owned by another Junban process")]
    AlreadyOwned,
    #[error("could not prepare profile: {0}")]
    Io(#[from] io::Error),
    #[error("could not open database: {0}")]
    Database(String),
}

/// Keeps a profile's lock and SQLite worker alive together.
pub struct ProfileOwner {
    repository: SqliteRepository,
}

impl ProfileOwner {
    pub fn open(profile_dir: impl AsRef<Path>) -> Result<Self, OpenError> {
        let profile_dir = profile_dir.as_ref();
        ensure_private_dir(profile_dir)?;

        let lock_path = profile_dir.join(LOCK_FILE);
        let lock = open_private_file(&lock_path)?;
        FileExt::try_lock(&lock).map_err(|error| match error {
            fs4::TryLockError::WouldBlock => OpenError::AlreadyOwned,
            fs4::TryLockError::Error(error) => OpenError::Io(error),
        })?;

        let database_path = profile_dir.join(DATABASE_FILE);
        open_private_file(&database_path)?;
        let repository = SqliteRepository::start(database_path, lock)?;
        Ok(Self { repository })
    }

    #[must_use]
    pub fn repository(&self) -> SqliteRepository {
        self.repository.clone()
    }
}

/// Creates a private directory. On Windows, a newly created profile inherits
/// the user's profile ACL; Junban never broadens that inherited protection.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn write_private_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    io::Write::write_all(&mut file, contents)?;
    file.sync_all()?;
    set_private_file_permissions(path)
}

fn open_private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    set_private_file_permissions(path)?;
    Ok(file)
}

fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[derive(Clone)]
pub struct SqliteRepository {
    worker: Arc<Worker>,
}

struct Worker {
    // The lock outlives the connection thread and every repository clone.
    _lock: File,
    sender: Mutex<Option<mpsc::Sender<Command>>>,
    join: Mutex<Option<thread::JoinHandle<()>>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.sender.lock().expect("worker sender poisoned").take();
        if let Some(join) = self.join.lock().expect("worker join poisoned").take() {
            let _ = join.join();
        }
    }
}

impl SqliteRepository {
    fn start(database_path: PathBuf, lock: File) -> Result<Self, OpenError> {
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("junban-sqlite".to_owned())
            .spawn(move || {
                let connection = open_connection(&database_path);
                match connection {
                    Ok(mut connection) => {
                        let _ = ready_sender.send(Ok(()));
                        run_worker(&mut connection, receiver);
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error.to_string()));
                    }
                }
            })?;

        match ready_receiver.recv() {
            Ok(Ok(())) => Ok(Self {
                worker: Arc::new(Worker {
                    _lock: lock,
                    sender: Mutex::new(Some(sender)),
                    join: Mutex::new(Some(join)),
                }),
            }),
            Ok(Err(error)) => {
                let _ = join.join();
                Err(OpenError::Database(error))
            }
            Err(error) => {
                let _ = join.join();
                Err(OpenError::Database(error.to_string()))
            }
        }
    }

    fn request<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<Result<T, RepositoryError>>) -> Command + Send + 'static,
    ) -> RepositoryFuture<'_, T>
    where
        T: Send + 'static,
    {
        let sender = self
            .worker
            .sender
            .lock()
            .expect("worker sender poisoned")
            .as_ref()
            .cloned();
        Box::pin(async move {
            let sender = sender.ok_or_else(|| {
                RepositoryError::Storage("database worker has stopped".to_owned())
            })?;
            let (reply_sender, reply_receiver) = oneshot::channel();
            sender
                .send(command(reply_sender))
                .map_err(|_| RepositoryError::Storage("database worker has stopped".to_owned()))?;
            reply_receiver
                .await
                .map_err(|_| RepositoryError::Storage("database worker did not reply".to_owned()))?
        })
    }

    #[cfg(test)]
    async fn diagnostics(&self) -> Result<Diagnostics, RepositoryError> {
        self.request(Command::Diagnostics).await
    }

    #[cfg(test)]
    async fn execute_batch(&self, sql: String) -> Result<(), RepositoryError> {
        self.request(move |reply| Command::ExecuteBatch { sql, reply })
            .await
    }
}

impl TaskRepository for SqliteRepository {
    fn create_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.request(move |reply| Command::Create {
            operation_id,
            task_id,
            title,
            due_date,
            now,
            reply,
        })
    }

    fn list_tasks(&self) -> RepositoryFuture<'_, TaskList> {
        self.request(Command::List)
    }

    fn replace_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.request(move |reply| Command::Replace {
            operation_id,
            task_id,
            title,
            due_date,
            now,
            reply,
        })
    }

    fn complete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.request(move |reply| Command::Complete {
            operation_id,
            task_id,
            now,
            reply,
        })
    }

    fn uncomplete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.request(move |reply| Command::Uncomplete {
            operation_id,
            task_id,
            now,
            reply,
        })
    }

    fn delete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        self.request(move |reply| Command::Delete {
            operation_id,
            task_id,
            now,
            reply,
        })
    }

    fn list_events(&self, since: u64) -> RepositoryFuture<'_, Vec<TaskEvent>> {
        self.request(move |reply| Command::Events { since, reply })
    }
}

#[allow(clippy::large_enum_variant)]
enum Command {
    Create {
        operation_id: OperationId,
        task_id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    List(oneshot::Sender<Result<TaskList, RepositoryError>>),
    Replace {
        operation_id: OperationId,
        task_id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    Complete {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    Uncomplete {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    Delete {
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        reply: oneshot::Sender<Result<CommittedMutation, RepositoryError>>,
    },
    Events {
        since: u64,
        reply: oneshot::Sender<Result<Vec<TaskEvent>, RepositoryError>>,
    },
    #[cfg(test)]
    Diagnostics(oneshot::Sender<Result<Diagnostics, RepositoryError>>),
    #[cfg(test)]
    ExecuteBatch {
        sql: String,
        reply: oneshot::Sender<Result<(), RepositoryError>>,
    },
}

fn run_worker(connection: &mut Connection, receiver: mpsc::Receiver<Command>) {
    for command in receiver {
        match command {
            Command::Create {
                operation_id,
                task_id,
                title,
                due_date,
                now,
                reply,
            } => {
                let _ = reply.send(create_task(
                    connection,
                    operation_id,
                    task_id,
                    title,
                    due_date,
                    now,
                ));
            }
            Command::List(reply) => {
                let _ = reply.send(list_tasks(connection));
            }
            Command::Replace {
                operation_id,
                task_id,
                title,
                due_date,
                now,
                reply,
            } => {
                let _ = reply.send(replace_task(
                    connection,
                    operation_id,
                    task_id,
                    title,
                    due_date,
                    now,
                ));
            }
            Command::Complete {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(change_completion(
                    connection,
                    operation_id,
                    task_id,
                    now,
                    true,
                ));
            }
            Command::Uncomplete {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(change_completion(
                    connection,
                    operation_id,
                    task_id,
                    now,
                    false,
                ));
            }
            Command::Delete {
                operation_id,
                task_id,
                now,
                reply,
            } => {
                let _ = reply.send(delete_task(connection, operation_id, task_id, now));
            }
            Command::Events { since, reply } => {
                let _ = reply.send(list_events(connection, since));
            }
            #[cfg(test)]
            Command::Diagnostics(reply) => {
                let _ = reply.send(read_diagnostics(connection));
            }
            #[cfg(test)]
            Command::ExecuteBatch { sql, reply } => {
                let result = connection.execute_batch(&sql).map_err(storage_error);
                let _ = reply.send(result);
            }
        }
    }
}

fn open_connection(path: &Path) -> rusqlite::Result<Connection> {
    let mut connection = Connection::open(path)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    migrate(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
        );",
    )?;
    let current: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if current < 1 {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "CREATE TABLE app_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                global_revision INTEGER NOT NULL CHECK (global_revision >= 0)
            );
            INSERT INTO app_state(singleton, global_revision) VALUES (1, 0);
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                due_date TEXT,
                status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
                completed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                revision INTEGER NOT NULL CHECK (revision > 0)
            );
            CREATE TABLE operation_receipts (
                operation_id TEXT PRIMARY KEY,
                request_json TEXT NOT NULL,
                response_json TEXT NOT NULL
            );
            CREATE TABLE activity (
                id INTEGER PRIMARY KEY,
                revision INTEGER NOT NULL UNIQUE,
                operation_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                task_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE events (
                revision INTEGER PRIMARY KEY,
                event_type TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                task_json TEXT,
                occurred_at TEXT NOT NULL
            );",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?1)",
            [Timestamp::now().to_string()],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CanonicalRequest<'a> {
    Create {
        title: &'a str,
        due_date: Option<String>,
    },
    Replace {
        task_id: String,
        title: &'a str,
        due_date: Option<String>,
    },
    Complete {
        task_id: String,
    },
    Uncomplete {
        task_id: String,
    },
    Delete {
        task_id: String,
    },
}

fn create_task(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    title: TaskTitle,
    due_date: Option<Date>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&CanonicalRequest::Create {
        title: title.as_str(),
        due_date: due_date.map(|date| date.to_string()),
    })?;
    mutate(
        connection,
        operation_id,
        request,
        TaskEventKind::Created,
        task_id,
        now,
        move |transaction, revision| {
            let task = Task::new(task_id, title, due_date, now, revision);
            transaction
                .execute(
                    "INSERT INTO tasks(
                        id, title, due_date, status, completed_at, created_at, updated_at, revision
                    ) VALUES (?1, ?2, ?3, 'pending', NULL, ?4, ?4, ?5)",
                    params![
                        task.id.to_string(),
                        task.title.as_str(),
                        task.due_date.map(|date| date.to_string()),
                        now.to_string(),
                        revision_to_i64(revision)?,
                    ],
                )
                .map_err(storage_error)?;
            Ok(Some(task))
        },
    )
}

fn replace_task(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    title: TaskTitle,
    due_date: Option<Date>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&CanonicalRequest::Replace {
        task_id: task_id.to_string(),
        title: title.as_str(),
        due_date: due_date.map(|date| date.to_string()),
    })?;
    mutate(
        connection,
        operation_id,
        request,
        TaskEventKind::Replaced,
        task_id,
        now,
        move |transaction, revision| {
            let changed = transaction
                .execute(
                    "UPDATE tasks SET title = ?1, due_date = ?2, updated_at = ?3, revision = ?4
                     WHERE id = ?5",
                    params![
                        title.as_str(),
                        due_date.map(|date| date.to_string()),
                        now.to_string(),
                        revision_to_i64(revision)?,
                        task_id.to_string(),
                    ],
                )
                .map_err(storage_error)?;
            if changed == 0 {
                return Err(RepositoryError::NotFound);
            }
            load_task(transaction, task_id).map(Some)
        },
    )
}

fn change_completion(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    now: Timestamp,
    completed: bool,
) -> Result<CommittedMutation, RepositoryError> {
    let request = if completed {
        canonical_json(&CanonicalRequest::Complete {
            task_id: task_id.to_string(),
        })?
    } else {
        canonical_json(&CanonicalRequest::Uncomplete {
            task_id: task_id.to_string(),
        })?
    };
    let kind = if completed {
        TaskEventKind::Completed
    } else {
        TaskEventKind::Uncompleted
    };
    mutate(
        connection,
        operation_id,
        request,
        kind,
        task_id,
        now,
        move |transaction, revision| {
            let (status, completed_at) = if completed {
                ("completed", Some(now.to_string()))
            } else {
                ("pending", None)
            };
            let changed = transaction
                .execute(
                    "UPDATE tasks SET status = ?1, completed_at = ?2, updated_at = ?3, revision = ?4
                     WHERE id = ?5",
                    params![
                        status,
                        completed_at,
                        now.to_string(),
                        revision_to_i64(revision)?,
                        task_id.to_string(),
                    ],
                )
                .map_err(storage_error)?;
            if changed == 0 {
                return Err(RepositoryError::NotFound);
            }
            load_task(transaction, task_id).map(Some)
        },
    )
}

fn delete_task(
    connection: &mut Connection,
    operation_id: OperationId,
    task_id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&CanonicalRequest::Delete {
        task_id: task_id.to_string(),
    })?;
    mutate(
        connection,
        operation_id,
        request,
        TaskEventKind::Deleted,
        task_id,
        now,
        move |transaction, _| {
            let changed = transaction
                .execute("DELETE FROM tasks WHERE id = ?1", [task_id.to_string()])
                .map_err(storage_error)?;
            if changed == 0 {
                return Err(RepositoryError::NotFound);
            }
            Ok(None)
        },
    )
}

fn mutate(
    connection: &mut Connection,
    operation_id: OperationId,
    request_json: String,
    kind: TaskEventKind,
    task_id: TaskId,
    now: Timestamp,
    apply: impl FnOnce(&Transaction<'_>, u64) -> Result<Option<Task>, RepositoryError>,
) -> Result<CommittedMutation, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;

    let receipt = transaction
        .query_row(
            "SELECT request_json, response_json FROM operation_receipts WHERE operation_id = ?1",
            [operation_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some((stored_request, stored_response)) = receipt {
        if stored_request != request_json {
            return Err(RepositoryError::IdempotencyMismatch);
        }
        return serde_json::from_str(&stored_response).map_err(storage_error);
    }

    let current_revision: i64 = transaction
        .query_row(
            "SELECT global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let revision = u64::try_from(current_revision)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| RepositoryError::Storage("global revision overflow".to_owned()))?;

    let task = apply(&transaction, revision)?;
    let event = TaskEvent {
        revision,
        operation_id,
        kind,
        task_id,
        task: task.clone(),
        occurred_at: now,
    };
    let response = CommittedMutation { task, event };
    let task_json = response
        .event
        .task
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(storage_error)?;
    let response_json = serde_json::to_string(&response).map_err(storage_error)?;

    transaction
        .execute(
            "UPDATE app_state SET global_revision = ?1 WHERE singleton = 1",
            [revision_to_i64(revision)?],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO activity(revision, operation_id, kind, task_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                revision_to_i64(revision)?,
                operation_id.to_string(),
                kind.as_str(),
                task_id.to_string(),
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO events(revision, event_type, operation_id, task_id, task_json, occurred_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                revision_to_i64(revision)?,
                kind.as_str(),
                operation_id.to_string(),
                task_id.to_string(),
                task_json,
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO operation_receipts(operation_id, request_json, response_json)
             VALUES (?1, ?2, ?3)",
            params![operation_id.to_string(), request_json, response_json],
        )
        .map_err(storage_error)?;
    transaction.commit().map_err(storage_error)?;
    Ok(response)
}

fn list_tasks(connection: &Connection) -> Result<TaskList, RepositoryError> {
    let revision: i64 = connection
        .query_row(
            "SELECT global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let mut statement = connection
        .prepare_cached(
            "SELECT id, title, due_date, status, completed_at, created_at, updated_at, revision
             FROM tasks ORDER BY created_at, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], task_from_row)
        .map_err(storage_error)?;
    let tasks = rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?;
    Ok(TaskList {
        tasks,
        revision: u64::try_from(revision)
            .map_err(|error| RepositoryError::Storage(error.to_string()))?,
    })
}

fn load_task(transaction: &Transaction<'_>, id: TaskId) -> Result<Task, RepositoryError> {
    transaction
        .query_row(
            "SELECT id, title, due_date, status, completed_at, created_at, updated_at, revision
             FROM tasks WHERE id = ?1",
            [id.to_string()],
            task_from_row,
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => RepositoryError::NotFound,
            other => storage_error(other),
        })
}

fn task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let id: String = row.get(0)?;
    let title: String = row.get(1)?;
    let due_date: Option<String> = row.get(2)?;
    let status: String = row.get(3)?;
    let completed_at: Option<String> = row.get(4)?;
    let created_at: String = row.get(5)?;
    let updated_at: String = row.get(6)?;
    let revision: i64 = row.get(7)?;

    Ok(Task {
        id: parse_sql(id, TaskId::parse)?,
        title: parse_sql(title, |raw| TaskTitle::new(raw.to_owned()))?,
        due_date: due_date
            .map(|value| parse_sql(value, |raw| raw.parse::<Date>()))
            .transpose()?,
        status: match status.as_str() {
            "pending" => TaskStatus::Pending,
            "completed" => TaskStatus::Completed,
            _ => return Err(invalid_sql("invalid task status")),
        },
        completed_at: completed_at
            .map(|value| parse_sql(value, |raw| raw.parse::<Timestamp>()))
            .transpose()?,
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
        revision: u64::try_from(revision).map_err(|error| invalid_sql(error.to_string()))?,
    })
}

fn list_events(connection: &Connection, since: u64) -> Result<Vec<TaskEvent>, RepositoryError> {
    let mut statement = connection
        .prepare_cached(
            "SELECT revision, event_type, operation_id, task_id, task_json, occurred_at
             FROM events WHERE revision > ?1 ORDER BY revision",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([revision_to_i64(since)?], |row| {
            let revision: i64 = row.get(0)?;
            let kind: String = row.get(1)?;
            let operation_id: String = row.get(2)?;
            let task_id: String = row.get(3)?;
            let task_json: Option<String> = row.get(4)?;
            let occurred_at: String = row.get(5)?;
            Ok(TaskEvent {
                revision: u64::try_from(revision)
                    .map_err(|error| invalid_sql(error.to_string()))?,
                operation_id: parse_sql(operation_id, OperationId::parse)?,
                kind: match kind.as_str() {
                    "task.created" => TaskEventKind::Created,
                    "task.replaced" => TaskEventKind::Replaced,
                    "task.completed" => TaskEventKind::Completed,
                    "task.uncompleted" => TaskEventKind::Uncompleted,
                    "task.deleted" => TaskEventKind::Deleted,
                    _ => return Err(invalid_sql("invalid event kind")),
                },
                task_id: parse_sql(task_id, TaskId::parse)?,
                task: task_json
                    .map(|json| serde_json::from_str(&json).map_err(invalid_sql))
                    .transpose()?,
                occurred_at: parse_sql(occurred_at, |raw| raw.parse::<Timestamp>())?,
            })
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn parse_sql<T, E>(value: String, parse: impl FnOnce(&str) -> Result<T, E>) -> rusqlite::Result<T>
where
    E: std::fmt::Display,
{
    parse(&value).map_err(invalid_sql)
}

fn invalid_sql(error: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(io::Error::new(
            io::ErrorKind::InvalidData,
            error.to_string(),
        )),
    )
}

fn canonical_json(value: &impl Serialize) -> Result<String, RepositoryError> {
    serde_json::to_string(value).map_err(storage_error)
}

fn revision_to_i64(revision: u64) -> Result<i64, RepositoryError> {
    i64::try_from(revision).map_err(|error| RepositoryError::Storage(error.to_string()))
}

fn storage_error(error: impl std::fmt::Display) -> RepositoryError {
    RepositoryError::Storage(error.to_string())
}

#[cfg(test)]
#[derive(Debug)]
struct Diagnostics {
    migration: i64,
    journal_mode: String,
    foreign_keys: i64,
    busy_timeout: i64,
    synchronous: i64,
    tasks: i64,
    receipts: i64,
    activity: i64,
    events: i64,
    revision: i64,
}

#[cfg(test)]
fn read_diagnostics(connection: &Connection) -> Result<Diagnostics, RepositoryError> {
    Ok(Diagnostics {
        migration: connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .map_err(storage_error)?,
        journal_mode: connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(storage_error)?,
        foreign_keys: connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .map_err(storage_error)?,
        busy_timeout: connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .map_err(storage_error)?,
        synchronous: connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .map_err(storage_error)?,
        tasks: table_count(connection, "tasks")?,
        receipts: table_count(connection, "operation_receipts")?,
        activity: table_count(connection, "activity")?,
        events: table_count(connection, "events")?,
        revision: connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(storage_error)?,
    })
}

#[cfg(test)]
fn table_count(connection: &Connection, table: &str) -> Result<i64, RepositoryError> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(storage_error)
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = env::temp_dir().join(format!(
                "junban-storage-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn operation() -> OperationId {
        OperationId::parse(&Uuid::new_v4().to_string()).unwrap()
    }

    fn now() -> Timestamp {
        "2026-07-28T12:00:00Z".parse().unwrap()
    }

    async fn create(
        repository: &SqliteRepository,
        operation_id: OperationId,
        title: &str,
    ) -> Result<CommittedMutation, RepositoryError> {
        repository
            .create_task(
                operation_id,
                TaskId::new(),
                TaskTitle::new(title).unwrap(),
                Some("2026-07-28".parse().unwrap()),
                now(),
            )
            .await
    }

    #[tokio::test]
    async fn migration_and_connection_pragmas_are_applied() {
        let directory = TestDir::new();
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let diagnostics = owner.repository().diagnostics().await.unwrap();

        assert_eq!(diagnostics.migration, 1);
        assert_eq!(diagnostics.journal_mode, "wal");
        assert_eq!(diagnostics.foreign_keys, 1);
        assert_eq!(diagnostics.busy_timeout, 2_500);
        assert_eq!(diagnostics.synchronous, 1); // NORMAL
    }

    #[test]
    fn a_second_profile_owner_is_rejected_until_all_clones_drop() {
        let directory = TestDir::new();
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repository = owner.repository();
        assert!(matches!(
            ProfileOwner::open(&directory.0),
            Err(OpenError::AlreadyOwned)
        ));
        drop(owner);
        assert!(matches!(
            ProfileOwner::open(&directory.0),
            Err(OpenError::AlreadyOwned)
        ));
        drop(repository);
        assert!(ProfileOwner::open(&directory.0).is_ok());
    }

    #[tokio::test]
    async fn exact_replay_returns_the_original_result_and_mismatch_conflicts() {
        let directory = TestDir::new();
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repository = owner.repository();
        let operation = operation();

        let first = create(&repository, operation, "First").await.unwrap();
        let replay = create(&repository, operation, "First").await.unwrap();
        assert_eq!(replay, first);
        assert_eq!(repository.list_tasks().await.unwrap().tasks.len(), 1);

        assert_eq!(
            create(&repository, operation, "Different").await,
            Err(RepositoryError::IdempotencyMismatch)
        );
        let diagnostics = repository.diagnostics().await.unwrap();
        assert_eq!((diagnostics.tasks, diagnostics.receipts), (1, 1));
        assert_eq!(
            (
                diagnostics.activity,
                diagnostics.events,
                diagnostics.revision
            ),
            (1, 1, 1)
        );
    }

    #[tokio::test]
    async fn mutations_write_effect_receipt_activity_revision_and_event_atomically() {
        let directory = TestDir::new();
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repository = owner.repository();
        let created = create(&repository, operation(), "Task").await.unwrap();
        let id = created.task.unwrap().id;
        repository
            .complete_task(operation(), id, now())
            .await
            .unwrap();

        let diagnostics = repository.diagnostics().await.unwrap();
        assert_eq!((diagnostics.tasks, diagnostics.receipts), (1, 2));
        assert_eq!(
            (
                diagnostics.activity,
                diagnostics.events,
                diagnostics.revision
            ),
            (2, 2, 2)
        );
        let events = repository.list_events(1).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TaskEventKind::Completed);
    }

    #[tokio::test]
    async fn restart_preserves_tasks_receipts_events_and_deleted_replays() {
        let directory = TestDir::new();
        let create_operation = operation();
        let delete_operation = operation();
        let (repository, id, deleted) = {
            let owner = ProfileOwner::open(&directory.0).unwrap();
            let repository = owner.repository();
            let created = create(&repository, create_operation, "Persistent")
                .await
                .unwrap();
            let id = created.task.unwrap().id;
            let deleted = repository
                .delete_task(delete_operation, id, now())
                .await
                .unwrap();
            (repository, id, deleted)
        };
        drop(repository);

        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repository = owner.repository();
        assert!(repository.list_tasks().await.unwrap().tasks.is_empty());
        assert_eq!(repository.list_events(0).await.unwrap().len(), 2);
        assert_eq!(
            repository
                .delete_task(delete_operation, id, Timestamp::now())
                .await
                .unwrap(),
            deleted
        );
    }

    #[tokio::test]
    async fn failed_activity_insert_rolls_back_every_mutation_row() {
        let directory = TestDir::new();
        let owner = ProfileOwner::open(&directory.0).unwrap();
        let repository = owner.repository();
        repository
            .execute_batch(
                "CREATE TRIGGER fail_activity BEFORE INSERT ON activity
                 BEGIN SELECT RAISE(ABORT, 'injected rollback'); END;"
                    .to_owned(),
            )
            .await
            .unwrap();

        assert!(matches!(
            create(&repository, operation(), "Rollback").await,
            Err(RepositoryError::Storage(_))
        ));
        let diagnostics = repository.diagnostics().await.unwrap();
        assert_eq!((diagnostics.tasks, diagnostics.receipts), (0, 0));
        assert_eq!(
            (
                diagnostics.activity,
                diagnostics.events,
                diagnostics.revision
            ),
            (0, 0, 0)
        );
    }

    #[cfg(unix)]
    #[test]
    fn profile_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = TestDir::new();
        let owner = ProfileOwner::open(&directory.0).unwrap();
        write_private_file(&directory.0.join("token"), b"secret").unwrap();
        drop(owner);
        assert_eq!(
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for file in [LOCK_FILE, DATABASE_FILE, "token"] {
            assert_eq!(
                fs::metadata(directory.0.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
