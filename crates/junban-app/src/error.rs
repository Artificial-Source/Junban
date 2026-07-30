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
    #[error("storage failed")]
    Storage,
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
        }
    }
}
