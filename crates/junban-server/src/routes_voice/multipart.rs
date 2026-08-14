//! Strict single-field audio multipart parsing for cloud STT.

use axum::{
    body::Bytes,
    http::{HeaderMap, header},
};
use junban_ai::SpeechAudioFormat;

use crate::{RequestId, error::ApiError};

use super::error::{body_too_large, invalid_multipart, unsupported_media_type};

pub(super) fn parse_audio_multipart(
    headers: &HeaderMap,
    body: &Bytes,
    request_id: &RequestId,
) -> Result<(SpeechAudioFormat, Bytes), ApiError> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| unsupported_media_type(request_id))?;
    let boundary =
        parse_boundary(content_type).ok_or_else(|| unsupported_media_type(request_id))?;
    if boundary.is_empty() || boundary.len() > 70 || !boundary.bytes().all(is_boundary_byte) {
        return Err(unsupported_media_type(request_id));
    }
    let opening = format!("--{boundary}\r\n").into_bytes();
    if !body.starts_with(&opening) {
        return Err(invalid_multipart(request_id));
    }
    let rest = &body[opening.len()..];
    let header_end = find_bytes(rest, b"\r\n\r\n").ok_or_else(|| invalid_multipart(request_id))?;
    if header_end > 8 * 1024 {
        return Err(invalid_multipart(request_id));
    }
    let raw_headers =
        std::str::from_utf8(&rest[..header_end]).map_err(|_| invalid_multipart(request_id))?;
    let mut disposition = None;
    let mut part_content_type = None;
    for line in raw_headers.split("\r\n") {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid_multipart(request_id))?;
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-disposition") && disposition.is_none() {
            disposition = Some(value);
        } else if name.eq_ignore_ascii_case("content-type") && part_content_type.is_none() {
            part_content_type = Some(value);
        } else {
            return Err(invalid_multipart(request_id));
        }
    }
    let disposition = disposition.ok_or_else(|| invalid_multipart(request_id))?;
    if !valid_audio_disposition(disposition) {
        return Err(invalid_multipart(request_id));
    }
    let part_content_type = part_content_type.ok_or_else(|| unsupported_media_type(request_id))?;
    // SpeechAudioFormat rejects parameters, whitespace, paths and unknown types.
    let format = SpeechAudioFormat::parse(part_content_type)
        .map_err(|_| unsupported_media_type(request_id))?;
    let audio_start = header_end + 4;
    let closing = format!("\r\n--{boundary}--").into_bytes();
    let audio_and_close = &rest[audio_start..];
    let close_at =
        find_bytes(audio_and_close, &closing).ok_or_else(|| invalid_multipart(request_id))?;
    let suffix = &audio_and_close[close_at + closing.len()..];
    if !matches!(suffix, b"" | b"\r\n") {
        // A second field, duplicate audio, epilogue, or malformed delimiter.
        return Err(invalid_multipart(request_id));
    }
    let audio = &audio_and_close[..close_at];
    if audio.is_empty() {
        return Err(invalid_multipart(request_id));
    }
    if audio.len() > junban_ai::MAX_SPEECH_AUDIO_BYTES {
        return Err(body_too_large(request_id));
    }
    let global_start = opening.len() + audio_start;
    Ok((format, body.slice(global_start..global_start + close_at)))
}

fn parse_boundary(content_type: &str) -> Option<&str> {
    let mut parts = content_type.split(';');
    if !parts
        .next()?
        .trim()
        .eq_ignore_ascii_case("multipart/form-data")
    {
        return None;
    }
    let mut boundary = None;
    for parameter in parts {
        let (name, value) = parameter.trim().split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("boundary") || boundary.is_some() {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        boundary = Some(value);
    }
    boundary
}

fn is_boundary_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'\'' | b'(' | b')' | b'+' | b'_' | b',' | b'-' | b'.' | b'/' | b':' | b'=' | b'?'
        )
}

fn valid_audio_disposition(value: &str) -> bool {
    let mut parts = value.split(';').map(str::trim);
    if !parts
        .next()
        .is_some_and(|value| value.eq_ignore_ascii_case("form-data"))
    {
        return false;
    }
    let mut name = None;
    let mut filename_seen = false;
    for part in parts {
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        if key.eq_ignore_ascii_case("name") && name.is_none() {
            name = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'));
        } else if key.eq_ignore_ascii_case("filename") && !filename_seen {
            filename_seen = true;
            if value.is_empty() || value.contains(['\r', '\n']) {
                return false;
            }
        } else {
            return false;
        }
    }
    name == Some("audio")
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
