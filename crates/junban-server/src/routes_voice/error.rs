//! Stable HTTP error conversion for cloud speech routes.

use axum::http::StatusCode;
use junban_ai::{ProviderError, ProviderErrorKind};

use crate::{RequestId, error::ApiError};

pub(super) fn speech_error(error: ProviderError, request_id: &RequestId) -> ApiError {
    match error.kind() {
        ProviderErrorKind::Invalid | ProviderErrorKind::BoundExceeded => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "speech_request_invalid",
            "speech request violates the selected provider contract",
            false,
            request_id,
        ),
        ProviderErrorKind::Cancelled => speech_cancelled(request_id),
        ProviderErrorKind::Unavailable => config_error(
            "confirmed speech provider does not support this operation",
            request_id,
        ),
        ProviderErrorKind::Connect
        | ProviderErrorKind::Timeout
        | ProviderErrorKind::HttpStatus
        | ProviderErrorKind::Stream => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "speech_provider_unavailable",
            "cloud speech provider is unavailable",
            true,
            request_id,
        ),
    }
}

pub(super) fn speech_runtime_error(
    error: crate::SpeechRuntimeError,
    request_id: &RequestId,
) -> ApiError {
    let (status, code) = match error {
        crate::SpeechRuntimeError::Capacity => (StatusCode::CONFLICT, "speech_capacity_reached"),
        crate::SpeechRuntimeError::NotRunning
        | crate::SpeechRuntimeError::InvalidEpoch
        | crate::SpeechRuntimeError::NotDrained => (
            StatusCode::SERVICE_UNAVAILABLE,
            "speech_runtime_unavailable",
        ),
    };
    ApiError::new(
        status,
        code,
        "cloud speech runtime is not accepting activity",
        true,
        request_id,
    )
}

pub(super) fn config_error(message: &'static str, request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "speech_not_configured",
        message,
        false,
        request_id,
    )
}

pub(super) fn stale_credential(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "credential_unavailable",
        "confirmed credential material is unavailable",
        false,
        request_id,
    )
}

pub(super) fn speech_cancelled(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "speech_cancelled",
        "cloud speech activity was cancelled",
        true,
        request_id,
    )
}

pub(super) fn invalid_multipart(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_multipart",
        "request must contain exactly one bounded audio field",
        false,
        request_id,
    )
}

pub(super) fn unsupported_media_type(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "unsupported_audio_type",
        "audio content type is not supported",
        false,
        request_id,
    )
}

pub(super) fn body_too_large(request_id: &RequestId) -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "body_too_large",
        "request body exceeds the configured limit",
        false,
        request_id,
    )
}
