//! Application-owned task use cases and persistence/event ports.

use std::{future::Future, pin::Pin, sync::Arc};

use jiff::{Timestamp, civil::Date};
use junban_domain::{OperationId, Task, TaskId, TaskTitle, ValidationError};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type RepositoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskEventKind {
    Created,
    Replaced,
    Completed,
    Uncompleted,
    Deleted,
}

impl TaskEventKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "task.created",
            Self::Replaced => "task.replaced",
            Self::Completed => "task.completed",
            Self::Uncompleted => "task.uncompleted",
            Self::Deleted => "task.deleted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskEvent {
    pub revision: u64,
    pub operation_id: OperationId,
    pub kind: TaskEventKind,
    pub task_id: TaskId,
    pub task: Option<Task>,
    pub occurred_at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommittedMutation {
    pub task: Option<Task>,
    pub event: TaskEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskList {
    pub tasks: Vec<Task>,
    pub revision: u64,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RepositoryError {
    #[error("task was not found")]
    NotFound,
    #[error("operation ID was already used for a different request")]
    IdempotencyMismatch,
    #[error("storage failed: {0}")]
    Storage(String),
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AppError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error("task was not found")]
    NotFound,
    #[error("operation ID was already used for a different request")]
    IdempotencyMismatch,
    #[error("storage failed")]
    Storage,
}

impl From<RepositoryError> for AppError {
    fn from(error: RepositoryError) -> Self {
        match error {
            RepositoryError::NotFound => Self::NotFound,
            RepositoryError::IdempotencyMismatch => Self::IdempotencyMismatch,
            RepositoryError::Storage(_) => Self::Storage,
        }
    }
}

pub trait TaskRepository: Send + Sync + 'static {
    fn create_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn list_tasks(&self) -> RepositoryFuture<'_, TaskList>;

    fn replace_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        title: TaskTitle,
        due_date: Option<Date>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn complete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn uncomplete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn list_events(&self, since: u64) -> RepositoryFuture<'_, Vec<TaskEvent>>;
}

pub trait EventSink: Send + Sync + 'static {
    fn publish(&self, event: TaskEvent);
}

#[derive(Debug)]
pub struct TaskService<R, E> {
    repository: Arc<R>,
    events: Arc<E>,
}

impl<R, E> Clone for TaskService<R, E> {
    fn clone(&self) -> Self {
        Self {
            repository: Arc::clone(&self.repository),
            events: Arc::clone(&self.events),
        }
    }
}

impl<R, E> TaskService<R, E>
where
    R: TaskRepository,
    E: EventSink,
{
    #[must_use]
    pub fn new(repository: Arc<R>, events: Arc<E>) -> Self {
        Self { repository, events }
    }

    pub async fn create_task(
        &self,
        operation_id: OperationId,
        title: String,
        due_date: Option<Date>,
    ) -> Result<CommittedMutation, AppError> {
        let title = TaskTitle::new(title)?;
        self.commit(
            self.repository
                .create_task(
                    operation_id,
                    TaskId::new(),
                    title,
                    due_date,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn list_tasks(&self) -> Result<TaskList, AppError> {
        self.repository.list_tasks().await.map_err(Into::into)
    }

    pub async fn replace_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        title: String,
        due_date: Option<Date>,
    ) -> Result<CommittedMutation, AppError> {
        let title = TaskTitle::new(title)?;
        self.commit(
            self.repository
                .replace_task(operation_id, task_id, title, due_date, Timestamp::now())
                .await,
        )
    }

    pub async fn complete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .complete_task(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn uncomplete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .uncomplete_task(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_task(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn list_events(&self, since: u64) -> Result<Vec<TaskEvent>, AppError> {
        self.repository.list_events(since).await.map_err(Into::into)
    }

    fn commit(
        &self,
        result: Result<CommittedMutation, RepositoryError>,
    ) -> Result<CommittedMutation, AppError> {
        let mutation = result.map_err(AppError::from)?;
        self.events.publish(mutation.event.clone());
        Ok(mutation)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use junban_domain::TaskStatus;
    use uuid::Uuid;

    struct FakeRepository {
        result: Mutex<Result<CommittedMutation, RepositoryError>>,
        calls: Mutex<Vec<&'static str>>,
    }

    impl FakeRepository {
        fn new(result: Result<CommittedMutation, RepositoryError>) -> Self {
            Self {
                result: Mutex::new(result),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn response(&self, call: &'static str) -> RepositoryFuture<'_, CommittedMutation> {
            self.calls.lock().unwrap().push(call);
            let result = self.result.lock().unwrap().clone();
            Box::pin(async move { result })
        }
    }

    impl TaskRepository for FakeRepository {
        fn create_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: TaskTitle,
            _: Option<Date>,
            _: Timestamp,
        ) -> RepositoryFuture<'_, CommittedMutation> {
            self.response("create")
        }

        fn list_tasks(&self) -> RepositoryFuture<'_, TaskList> {
            self.calls.lock().unwrap().push("list");
            Box::pin(async {
                Ok(TaskList {
                    tasks: Vec::new(),
                    revision: 0,
                })
            })
        }

        fn replace_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: TaskTitle,
            _: Option<Date>,
            _: Timestamp,
        ) -> RepositoryFuture<'_, CommittedMutation> {
            self.response("replace")
        }

        fn complete_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> RepositoryFuture<'_, CommittedMutation> {
            self.response("complete")
        }

        fn uncomplete_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> RepositoryFuture<'_, CommittedMutation> {
            self.response("uncomplete")
        }

        fn delete_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> RepositoryFuture<'_, CommittedMutation> {
            self.response("delete")
        }

        fn list_events(&self, _: u64) -> RepositoryFuture<'_, Vec<TaskEvent>> {
            self.calls.lock().unwrap().push("events");
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<TaskEvent>>);

    impl EventSink for RecordingSink {
        fn publish(&self, event: TaskEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn operation_id() -> OperationId {
        OperationId::parse(&Uuid::new_v4().to_string()).unwrap()
    }

    fn mutation() -> CommittedMutation {
        let now: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
        let task = Task::new(TaskId::new(), TaskTitle::new("Task").unwrap(), None, now, 1);
        CommittedMutation {
            task: Some(task.clone()),
            event: TaskEvent {
                revision: 1,
                operation_id: operation_id(),
                kind: TaskEventKind::Created,
                task_id: task.id,
                task: Some(task),
                occurred_at: now,
            },
        }
    }

    #[tokio::test]
    async fn create_validates_then_publishes_the_committed_event() {
        let expected = mutation();
        let repository = Arc::new(FakeRepository::new(Ok(expected.clone())));
        let sink = Arc::new(RecordingSink::default());
        let service = TaskService::new(Arc::clone(&repository), Arc::clone(&sink));

        let actual = service
            .create_task(operation_id(), "Task".to_owned(), None)
            .await
            .unwrap();

        assert_eq!(actual, expected);
        assert_eq!(*repository.calls.lock().unwrap(), vec!["create"]);
        assert_eq!(*sink.0.lock().unwrap(), vec![expected.event]);
    }

    #[tokio::test]
    async fn invalid_title_never_reaches_storage_or_event_sink() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation())));
        let sink = Arc::new(RecordingSink::default());
        let service = TaskService::new(Arc::clone(&repository), Arc::clone(&sink));

        assert_eq!(
            service
                .create_task(operation_id(), "  ".to_owned(), None)
                .await,
            Err(AppError::Validation(ValidationError::EmptyTitle))
        );
        assert!(repository.calls.lock().unwrap().is_empty());
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn every_mutation_uses_the_repository_and_publishes() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation())));
        let sink = Arc::new(RecordingSink::default());
        let service = TaskService::new(Arc::clone(&repository), Arc::clone(&sink));
        let id = TaskId::new();

        service
            .replace_task(operation_id(), id, "Changed".to_owned(), None)
            .await
            .unwrap();
        service.complete_task(operation_id(), id).await.unwrap();
        service.uncomplete_task(operation_id(), id).await.unwrap();
        service.delete_task(operation_id(), id).await.unwrap();

        assert_eq!(
            *repository.calls.lock().unwrap(),
            vec!["replace", "complete", "uncomplete", "delete"]
        );
        assert_eq!(sink.0.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn reads_use_the_repository_without_publishing() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation())));
        let sink = Arc::new(RecordingSink::default());
        let service = TaskService::new(Arc::clone(&repository), Arc::clone(&sink));

        assert_eq!(service.list_tasks().await.unwrap().revision, 0);
        assert!(service.list_events(12).await.unwrap().is_empty());
        assert_eq!(*repository.calls.lock().unwrap(), vec!["list", "events"]);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn repository_failures_map_without_publishing() {
        for (repository_error, app_error) in [
            (RepositoryError::NotFound, AppError::NotFound),
            (
                RepositoryError::IdempotencyMismatch,
                AppError::IdempotencyMismatch,
            ),
            (
                RepositoryError::Storage("disk full".to_owned()),
                AppError::Storage,
            ),
        ] {
            let repository = Arc::new(FakeRepository::new(Err(repository_error)));
            let sink = Arc::new(RecordingSink::default());
            let service = TaskService::new(repository, Arc::clone(&sink));
            assert_eq!(
                service.complete_task(operation_id(), TaskId::new()).await,
                Err(app_error)
            );
            assert!(sink.0.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn task_fixture_starts_pending() {
        assert_eq!(mutation().task.unwrap().status, TaskStatus::Pending);
    }
}
