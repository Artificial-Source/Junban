use super::*;
use crate::RequestId;
use axum::{
    body::Bytes,
    http::{HeaderMap, HeaderValue, StatusCode, header},
};
use junban_ai::{SpeechAudio, SpeechAudioFormat};

use super::handlers::synthesis_response;
use super::multipart::parse_audio_multipart;

fn multipart(content_type: &str, bytes: &[u8]) -> (HeaderMap, Bytes) {
    let boundary = "strict-boundary";
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("multipart/form-data; boundary=strict-boundary"),
    );
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"voice\"\r\nContent-Type: {content_type}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (headers, Bytes::from(body))
}

#[test]
fn multipart_accepts_exactly_one_bounded_audio_field() {
    let request_id = RequestId("multipart-test".into());
    let (headers, body) = multipart("audio/wav", b"audio");
    let (format, parsed) = parse_audio_multipart(&headers, &body, &request_id).unwrap();
    assert_eq!(format, SpeechAudioFormat::Wav);
    assert_eq!(&parsed[..], b"audio");
}

#[test]
fn multipart_rejects_params_duplicates_unknown_fields_and_trailing_bytes() {
    let request_id = RequestId("multipart-test".into());
    let (headers, body) = multipart("audio/wav; codecs=pcm", b"audio");
    assert_eq!(
        parse_audio_multipart(&headers, &body, &request_id)
            .unwrap_err()
            .status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let (headers, body) = multipart("audio/wav", b"audio");
    let mut body = body.to_vec();
    body.extend_from_slice(b"epilogue");
    let body = Bytes::from(body);
    assert_eq!(
        parse_audio_multipart(&headers, &body, &request_id)
            .unwrap_err()
            .status,
        StatusCode::BAD_REQUEST
    );
    let unknown = String::from_utf8(body.to_vec())
        .unwrap()
        .replace("name=\"audio\"", "name=\"other\"");
    assert!(parse_audio_multipart(&headers, &Bytes::from(unknown), &request_id).is_err());
}

#[tokio::test]
async fn synthesis_response_is_canonical_bounded_binary() {
    let response = synthesis_response(
        SpeechAudio::new(SpeechAudioFormat::Mp3, b"canonical-audio".to_vec()).unwrap(),
    );
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/mpeg");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "15");
    let bytes = axum::body::to_bytes(response.into_body(), 32)
        .await
        .unwrap();
    assert_eq!(&bytes[..], b"canonical-audio");
}

#[test]
fn synthesis_json_is_strict() {
    assert!(serde_json::from_str::<SpeechSynthesisRequest>(r#"{"text":"hello"}"#).is_ok());
    assert!(
        serde_json::from_str::<SpeechSynthesisRequest>(r#"{"text":"hello","model":"x"}"#).is_err()
    );
}
