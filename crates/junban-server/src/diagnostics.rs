//! Bounded in-memory diagnostic ring with best-effort secret redaction.

use std::collections::VecDeque;
use std::sync::Mutex;

use jiff::Timestamp;
use serde::Serialize;
use utoipa::ToSchema;

/// Maximum retained diagnostic entries for the process-local ring.
pub const DIAGNOSTIC_RING_CAPACITY: usize = 1000;

/// Severity of a diagnostic entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

/// One structured diagnostic record. Messages must already be redacted.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DiagnosticEntry {
    /// RFC3339 / ISO-8601 timestamp from the server clock.
    pub timestamp: String,
    pub severity: DiagnosticSeverity,
    /// Stable machine-facing event code.
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Human-readable detail; never includes raw secrets.
    pub message: String,
}

/// Bounded in-memory diagnostic ring buffer.
pub struct DiagnosticRing {
    entries: Mutex<VecDeque<DiagnosticEntry>>,
    max_entries: usize,
}

impl DiagnosticRing {
    #[must_use]
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(max_entries.min(64))),
            max_entries: max_entries.max(1),
        }
    }

    /// Append one entry, dropping the oldest when at capacity.
    pub fn log(
        &self,
        severity: DiagnosticSeverity,
        code: &str,
        request_id: Option<&str>,
        message: &str,
    ) {
        let entry = DiagnosticEntry {
            timestamp: Timestamp::now().to_string(),
            severity,
            code: code.to_owned(),
            request_id: request_id.map(str::to_owned),
            message: message.to_owned(),
        };
        let mut entries = self.entries.lock().expect("diagnostics ring poisoned");
        while entries.len() >= self.max_entries {
            entries.pop_front();
        }
        entries.push_back(entry);
    }

    /// Snapshot entries from oldest to newest.
    #[must_use]
    pub fn snapshot(&self) -> Vec<DiagnosticEntry> {
        self.entries
            .lock()
            .expect("diagnostics ring poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// Drop all retained entries.
    pub fn clear(&self) {
        self.entries
            .lock()
            .expect("diagnostics ring poisoned")
            .clear();
    }
}

/// Strip sensitive values from a string that may contain secrets.
///
/// Best-effort redaction for diagnostics — not a security boundary.
#[must_use]
pub fn redact_secrets(input: &str, token: &str) -> String {
    let mut out = input.to_owned();
    if !token.is_empty() {
        out = out.replace(token, "[REDACTED]");
    }
    out = redact_authorization_header_values(&out);
    out = redact_bearer_credentials(&out);
    out = redact_url_userinfo(&out);
    out = redact_query_strings(&out);
    out
}

fn redact_authorization_header_values(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut idx = 0;
    while let Some(rel) = lower[idx..].find("authorization:") {
        let start = idx + rel;
        out.push_str(&input[idx..start]);
        out.push_str(&input[start..start + "authorization:".len()]);
        let mut cursor = start + "authorization:".len();
        // Preserve horizontal whitespace after the header name.
        while cursor < input.len() {
            let byte = input.as_bytes()[cursor];
            if byte == b' ' || byte == b'\t' {
                out.push(byte as char);
                cursor += 1;
            } else {
                break;
            }
        }
        out.push_str("[REDACTED]");
        // Consume up to two tokens so "Bearer <secret>" is fully covered.
        for _ in 0..2 {
            let before = cursor;
            while cursor < input.len() {
                let byte = input.as_bytes()[cursor];
                if byte.is_ascii_whitespace()
                    || byte == b','
                    || byte == b'"'
                    || byte == b'\''
                    || byte == b')'
                    || byte == b']'
                {
                    break;
                }
                cursor += 1;
            }
            if cursor == before {
                break;
            }
            // Skip a single space/tab between Bearer and the credential.
            if cursor < input.len()
                && (input.as_bytes()[cursor] == b' ' || input.as_bytes()[cursor] == b'\t')
            {
                // Only continue to the second token when the first looked like Bearer.
                let first = input[before..cursor].eq_ignore_ascii_case("bearer");
                if first {
                    cursor += 1;
                    continue;
                }
            }
            break;
        }
        idx = cursor;
    }
    out.push_str(&input[idx..]);
    out
}

fn redact_bearer_credentials(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut idx = 0;
    while let Some(rel) = lower[idx..].find("bearer ") {
        let start = idx + rel;
        out.push_str(&input[idx..start]);
        out.push_str(&input[start..start + "bearer ".len()]);
        out.push_str("[REDACTED]");
        let mut cursor = start + "bearer ".len();
        while cursor < input.len() {
            let byte = input.as_bytes()[cursor];
            if byte.is_ascii_whitespace()
                || byte == b','
                || byte == b'"'
                || byte == b'\''
                || byte == b')'
                || byte == b']'
            {
                break;
            }
            cursor += 1;
        }
        idx = cursor;
    }
    out.push_str(&input[idx..]);
    out
}

fn redact_url_userinfo(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if let Some(colon) = find_next_url_scheme(bytes, idx) {
            out.push_str(&input[idx..colon]);
            out.push_str("://");
            let rest = colon + 3;
            if let Some(at_rel) = input[rest..].find('@') {
                let userinfo_end = rest + at_rel;
                let userinfo = &input[rest..userinfo_end];
                // userinfo cannot contain '/', '?', '#', or whitespace.
                if !userinfo.is_empty()
                    && !userinfo
                        .bytes()
                        .any(|b| b == b'/' || b == b'?' || b == b'#' || b.is_ascii_whitespace())
                {
                    out.push_str("[REDACTED]@");
                    idx = userinfo_end + 1;
                    continue;
                }
            }
            idx = rest;
            continue;
        }
        out.push_str(&input[idx..]);
        break;
    }
    out
}

/// Find `scheme://` starting at or after `start`. Returns the index of `:`.
fn find_next_url_scheme(bytes: &[u8], start: usize) -> Option<usize> {
    let mut search = start;
    while search + 3 < bytes.len() {
        let rel = bytes[search..]
            .windows(3)
            .position(|window| window == b"://")?;
        let colon = search + rel;
        // Walk back over a candidate scheme immediately before "://".
        let mut scheme_start = colon;
        while scheme_start > start {
            let prev = bytes[scheme_start - 1];
            if prev.is_ascii_alphanumeric() || prev == b'+' || prev == b'-' || prev == b'.' {
                scheme_start -= 1;
            } else {
                break;
            }
        }
        if scheme_start < colon
            && bytes[scheme_start].is_ascii_alphabetic()
            && scheme_start >= start
        {
            return Some(colon);
        }
        search = colon + 3;
    }
    None
}

fn redact_query_strings(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '?' {
            out.push('?');
            out.push_str("[REDACTED]");
            while let Some(next) = chars.peek().copied() {
                if next.is_whitespace() || next == '"' || next == '\'' || next == ')' || next == ']'
                {
                    break;
                }
                chars.next();
            }
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_bounds_and_clear() {
        let ring = DiagnosticRing::new(2);
        ring.log(DiagnosticSeverity::Info, "a", None, "one");
        ring.log(DiagnosticSeverity::Warning, "b", Some("r1"), "two");
        ring.log(DiagnosticSeverity::Error, "c", None, "three");
        let snap = ring.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].code, "b");
        assert_eq!(snap[1].code, "c");
        ring.clear();
        assert!(ring.snapshot().is_empty());
    }

    #[test]
    fn redacts_token_authorization_bearer_userinfo_and_query() {
        let token = "super-secret-token-value";
        let input = format!(
            "token={token} Authorization: Bearer {token} and bearer {token} \
             url=https://user:pass@example.com/path?x=1&y=2 end"
        );
        let redacted = redact_secrets(&input, token);
        assert!(!redacted.contains(token), "{redacted}");
        assert!(!redacted.contains("user:pass"), "{redacted}");
        assert!(!redacted.contains("x=1"), "{redacted}");
        assert!(redacted.contains("[REDACTED]"), "{redacted}");
        assert!(
            redacted.contains("https://[REDACTED]@example.com/path?[REDACTED]"),
            "unexpected redaction: {redacted}"
        );
    }
}
