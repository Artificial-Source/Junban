//! Incremental SSE decoder for provider streams.
//!
//! Safe across arbitrary byte-chunk and UTF-8 fragmentation. Enforces the
//! frozen 64 KiB frame and 1 MiB response bounds. Keepalive comments carry no
//! data and are discarded.

use crate::bounds::{MAX_PROVIDER_RESPONSE_BYTES, MAX_PROVIDER_STREAM_FRAME_BYTES};
use crate::error::ProviderError;

/// One complete SSE event (one or more `data:` lines joined by `\n`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
}

/// Incremental Server-Sent Events decoder.
#[derive(Debug, Default)]
pub struct SseDecoder {
    /// Incomplete trailing UTF-8 bytes from the previous chunk.
    byte_carry: Vec<u8>,
    /// Incomplete text line (without the terminating newline).
    line_carry: String,
    /// Accumulated `data:` lines for the current frame.
    data_lines: Vec<String>,
    event_name: Option<String>,
    event_id: Option<String>,
    /// Bytes contributing to the current frame (field lines only).
    frame_bytes: usize,
    /// Total response body bytes accepted.
    total_bytes: usize,
    finished: bool,
}

impl SseDecoder {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Push an arbitrary body chunk and return any completed events.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, ProviderError> {
        if self.finished {
            return Err(ProviderError::stream("SSE decoder already finished"));
        }
        if chunk.is_empty() {
            return Ok(Vec::new());
        }

        self.account_response_bytes(chunk.len())?;

        let mut bytes = std::mem::take(&mut self.byte_carry);
        bytes.extend_from_slice(chunk);

        let text = match std::str::from_utf8(&bytes) {
            // byte_carry already taken and left empty on the complete path.
            Ok(text) => text.to_owned(),
            Err(error) => {
                let valid = error.valid_up_to();
                if error.error_len().is_some() {
                    return Err(ProviderError::stream("invalid UTF-8 in provider SSE body"));
                }
                // Incomplete sequence at the end — hold trailing bytes.
                let text = std::str::from_utf8(&bytes[..valid])
                    .map_err(|_| ProviderError::stream("invalid UTF-8 in provider SSE body"))?
                    .to_owned();
                self.byte_carry = bytes[valid..].to_vec();
                // Incomplete UTF-8 sequences are small; reject pathological carry.
                if self.byte_carry.len() > 4 {
                    return Err(ProviderError::stream(
                        "invalid UTF-8 carry in provider SSE body",
                    ));
                }
                text
            }
        };

        self.push_text(&text)
    }

    /// Finish the stream. A trailing partial event without a blank line is rejected
    /// unless it is only whitespace/comments with no field data.
    pub fn finish(&mut self) -> Result<Vec<SseEvent>, ProviderError> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;

        if !self.byte_carry.is_empty() {
            return Err(ProviderError::stream(
                "truncated UTF-8 sequence at end of provider SSE body",
            ));
        }

        let mut events = Vec::new();
        if !self.line_carry.is_empty() {
            let line = std::mem::take(&mut self.line_carry);
            if let Some(event) = self.push_line(&line)? {
                events.push(event);
            }
        }

        if self.has_pending_fields() {
            // Spec allows EOF to dispatch the final event; do so explicitly.
            if let Some(event) = self.dispatch_event()? {
                events.push(event);
            }
        }

        Ok(events)
    }

    fn push_text(&mut self, text: &str) -> Result<Vec<SseEvent>, ProviderError> {
        let mut events = Vec::new();
        // Normalize CR LF / lone CR into LF so fragmented CRLF never leaves a
        // bare `\r` field name across chunk boundaries.
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let mut rest = normalized.as_str();
        while let Some(newline_at) = rest.find('\n') {
            let mut line = rest[..newline_at].to_owned();
            rest = &rest[newline_at + 1..];
            if !self.line_carry.is_empty() {
                self.line_carry.push_str(&line);
                line = std::mem::take(&mut self.line_carry);
            }
            if let Some(event) = self.push_line(&line)? {
                events.push(event);
            }
        }
        if !rest.is_empty() {
            self.line_carry.push_str(rest);
            // A single unterminated line still counts toward the frame bound.
            self.ensure_frame_bound(self.frame_bytes.saturating_add(self.line_carry.len()))?;
        }
        Ok(events)
    }

    fn push_line(&mut self, line: &str) -> Result<Option<SseEvent>, ProviderError> {
        // Blank line dispatches the current event.
        if line.is_empty() {
            return self.dispatch_event();
        }

        // Comment / keepalive.
        if line.starts_with(':') {
            return Ok(None);
        }

        let (field, value) = split_field(line);
        let value = trim_one_leading_space(value);

        // Count the full wire line toward the frame bound.
        let line_bytes = line.len().saturating_add(1); // include newline
        self.frame_bytes = self.frame_bytes.saturating_add(line_bytes);
        self.ensure_frame_bound(self.frame_bytes)?;

        match field {
            "data" => self.data_lines.push(value.to_owned()),
            "event" => self.event_name = Some(value.to_owned()),
            "id" => {
                if !value.contains('\0') {
                    self.event_id = Some(value.to_owned());
                }
            }
            "retry" => {
                // Provider streams do not honor client reconnection retry here.
            }
            _ => {
                return Err(ProviderError::stream(format!(
                    "unknown SSE field `{field}`"
                )));
            }
        }
        Ok(None)
    }

    fn dispatch_event(&mut self) -> Result<Option<SseEvent>, ProviderError> {
        if !self.has_pending_fields() {
            self.reset_frame();
            return Ok(None);
        }

        let data = self.data_lines.join("\n");
        let event = SseEvent {
            event: self.event_name.take(),
            data,
            id: self.event_id.take(),
        };
        self.reset_frame();
        Ok(Some(event))
    }

    fn has_pending_fields(&self) -> bool {
        !self.data_lines.is_empty() || self.event_name.is_some() || self.event_id.is_some()
    }

    fn reset_frame(&mut self) {
        self.data_lines.clear();
        self.event_name = None;
        self.event_id = None;
        self.frame_bytes = 0;
    }

    fn account_response_bytes(&mut self, incoming: usize) -> Result<(), ProviderError> {
        let total = self
            .total_bytes
            .checked_add(incoming)
            .ok_or_else(|| ProviderError::bound("provider_response_bytes"))?;
        if total > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(ProviderError::bound("provider_response_bytes"));
        }
        self.total_bytes = total;
        Ok(())
    }

    fn ensure_frame_bound(&self, frame_bytes: usize) -> Result<(), ProviderError> {
        if frame_bytes > MAX_PROVIDER_STREAM_FRAME_BYTES {
            return Err(ProviderError::bound("provider_stream_frame_bytes"));
        }
        Ok(())
    }
}

fn split_field(line: &str) -> (&str, &str) {
    match line.split_once(':') {
        Some((field, value)) => (field, value),
        None => (line, ""),
    }
}

fn trim_one_leading_space(value: &str) -> &str {
    value.strip_prefix(' ').unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_fragmented_multibyte_utf8_and_data_lines() {
        // "你好" is e4 bd a0 e5 a5 bd
        let mut decoder = SseDecoder::new();
        let mut events = Vec::new();
        events.extend(decoder.push(b"data: {\"text\":\"").unwrap());
        events.extend(decoder.push(&[0xe4, 0xbd]).unwrap());
        events.extend(decoder.push(&[0xa0, 0xe5]).unwrap());
        events.extend(decoder.push(&[0xa5, 0xbd]).unwrap());
        events.extend(decoder.push(b"\"}\n\n").unwrap());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "{\"text\":\"你好\"}");
    }

    #[test]
    fn rejects_unknown_field_and_oversized_frame() {
        let mut decoder = SseDecoder::new();
        let err = decoder.push(b"foo: bar\n\n").unwrap_err();
        assert!(matches!(err, ProviderError::Stream { .. }));

        let mut decoder = SseDecoder::new();
        let huge = format!("data: {}\n\n", "x".repeat(MAX_PROVIDER_STREAM_FRAME_BYTES));
        let err = decoder.push(huge.as_bytes()).unwrap_err();
        assert!(matches!(
            err,
            ProviderError::BoundExceeded {
                bound: "provider_stream_frame_bytes"
            }
        ));
    }

    #[test]
    fn ignores_comments_and_dispatches_on_finish() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b": keep-alive\n").unwrap().is_empty());
        assert!(decoder.push(b"data: hi").unwrap().is_empty());
        let events = decoder.finish().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "hi");
    }
}
