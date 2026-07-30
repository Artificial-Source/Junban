//! HTTP error envelope and application-error mapping.

use std::collections::BTreeMap;

use axum::{
    Json,
    extract::rejection::JsonRejection,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use junban_app::AppError;
use junban_domain::{OperationId, ValidationError};

use crate::{MAX_BODY_BYTES, RequestId};

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
    pub request_id: String,
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<BTreeMap<String, String>>,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub envelope: ErrorEnvelope,
}

impl ApiError {
    pub fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
        request_id: &RequestId,
    ) -> Self {
        Self {
            status,
            envelope: ErrorEnvelope {
                error: ErrorBody {
                    code,
                    message: message.into(),
                    retryable,
                    fields: None,
                },
                request_id: request_id.0.clone(),
            },
        }
    }

    pub fn with_field(mut self, field: impl Into<String>, message: impl Into<String>) -> Self {
        self.envelope
            .error
            .fields
            .get_or_insert_with(BTreeMap::new)
            .insert(field.into(), message.into());
        self
    }

    pub fn from_app(error: AppError, request_id: &RequestId) -> Self {
        match error {
            AppError::Validation(error) => validation_error(error, request_id),
            AppError::NotFound => Self::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "resource was not found",
                false,
                request_id,
            ),
            AppError::Conflict => Self::new(
                StatusCode::CONFLICT,
                "conflict",
                "operation conflicts with current state",
                false,
                request_id,
            ),
            AppError::IdempotencyMismatch => Self::new(
                StatusCode::CONFLICT,
                "idempotency_mismatch",
                "Idempotency-Key was already used for a different request",
                false,
                request_id,
            ),
            AppError::OperationTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "operation_too_large",
                "operation exceeds size or row limits",
                false,
                request_id,
            ),
            AppError::Storage => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "storage_unavailable",
                "storage is temporarily unavailable",
                true,
                request_id,
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.envelope)).into_response()
    }
}

pub fn validation_error(error: ValidationError, request_id: &RequestId) -> ApiError {
    // Field details carry the stable machine-facing reason; the top-level message stays generic.
    let detail = match &error {
        ValidationError::InvalidId { .. } => "must be a UUID".to_owned(),
        ValidationError::EmptyTitle => "must not be empty".to_owned(),
        ValidationError::TitleTooLong { max } => format!("must contain at most {max} characters"),
        ValidationError::Empty { .. } => "must not be empty".to_owned(),
        ValidationError::TooLong { max, .. } => format!("must contain at most {max} characters"),
        ValidationError::TooSmall { min, .. } => format!("must be at least {min}"),
        ValidationError::OutOfRange { min, max, .. } => format!("must be between {min} and {max}"),
        ValidationError::InvalidFormat { expected, .. } => format!("must match {expected}"),
        ValidationError::Invalid { reason, .. } => (*reason).to_owned(),
        ValidationError::TooMany { count, max, .. } => {
            format!("contains {count} items; at most {max} are allowed")
        }
        ValidationError::Duplicate { .. } => "contains duplicate values".to_owned(),
        ValidationError::Cycle { .. } => "would create a cycle".to_owned(),
        ValidationError::IncompletePermutation { .. } => {
            "is not a complete permutation of the expected scope".to_owned()
        }
    };
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "validation_error",
        "request validation failed",
        false,
        request_id,
    )
    .with_field(error.field(), detail)
}

pub fn operation_id(headers: &HeaderMap, request_id: &RequestId) -> Result<OperationId, ApiError> {
    let raw = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "validation_error",
                "request validation failed",
                false,
                request_id,
            )
            .with_field(
                "idempotency_key",
                "a UUID Idempotency-Key header is required",
            )
        })?;
    OperationId::parse(raw).map_err(|error| validation_error(error, request_id))
}

pub fn extract_json<T>(
    payload: Result<Json<T>, JsonRejection>,
    request_id: &RequestId,
) -> Result<T, ApiError> {
    payload.map(|Json(value)| value).map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                format!("request body must not exceed {MAX_BODY_BYTES} bytes"),
                false,
                request_id,
            )
        } else {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "request body must be valid JSON",
                false,
                request_id,
            )
        }
    })
}

pub fn parse_path_id<T, F>(raw: &str, parse: F, request_id: &RequestId) -> Result<T, ApiError>
where
    F: FnOnce(&str) -> Result<T, ValidationError>,
{
    parse(raw).map_err(|error| validation_error(error, request_id))
}
