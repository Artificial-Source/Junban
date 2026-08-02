//! Application and repository error types.

use junban_domain::ValidationError;
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RepositoryError {
    #[error("resource was not found")]
    NotFound,
    #[error("operation conflicts with current state")]
    Conflict,
    #[error("operation ID was already used for a different request")]
    IdempotencyMismatch,
    #[error("operation exceeds size or row limits")]
    OperationTooLarge,
    #[error("{0}")]
    Validation(ValidationError),
    #[error("storage failed: {0}")]
    Storage(String),
    #[error(
        "restore apply failed ({apply}); rollback also failed ({rollback}); rollback snapshot retained at {rollback_path}"
    )]
    CatastrophicRestore {
        apply: String,
        rollback: String,
        rollback_path: String,
    },
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AppError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error("resource was not found")]
    NotFound,
    #[error("operation conflicts with current state")]
    Conflict,
    #[error("operation ID was already used for a different request")]
    IdempotencyMismatch,
    #[error("operation exceeds size or row limits")]
    OperationTooLarge,
    #[error("query result exceeds the allowed limit")]
    ResultLimitExceeded,
    #[error("storage failed")]
    Storage,
    #[error("restore failed and the live database could not be validated after rollback")]
    CatastrophicRestore,
}

impl From<RepositoryError> for AppError {
    fn from(error: RepositoryError) -> Self {
        match error {
            RepositoryError::NotFound => Self::NotFound,
            RepositoryError::Conflict => Self::Conflict,
            RepositoryError::IdempotencyMismatch => Self::IdempotencyMismatch,
            RepositoryError::OperationTooLarge => Self::OperationTooLarge,
            RepositoryError::Validation(error) => Self::Validation(error),
            RepositoryError::Storage(_) => Self::Storage,
            RepositoryError::CatastrophicRestore { .. } => Self::CatastrophicRestore,
        }
    }
}
