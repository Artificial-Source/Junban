//! Pure import/export transfer formats for task portability.
//!
//! Markdown, JSON, and CSV are transfer formats only — never live backends.
//! Parsers produce a fingerprint-bound preview; apply requires the same bytes.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Read, Write};

use jiff::civil::Date;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    MAX_BULK_IDS, MAX_MARKDOWN_CHARS, MAX_TASK_TITLE_CHARS, MarkdownText, Priority, Project, Tag,
    Task, TaskStatus, TaskTitle, ValidationError, text_import::parse_text_import,
};

/// Maximum UTF-8 bytes accepted for one transfer payload (matches the 8 MiB upload ceiling).
pub const MAX_TRANSFER_CONTENT_BYTES: usize = 8 * 1024 * 1024;

// ── Complete profile backup envelope (.junban-backup) ───────────────────────

/// Magic bytes for `.junban-backup` files.
pub const BACKUP_MAGIC: &[u8; 4] = b"JNBK";
/// Current framing version for the backup envelope.
pub const BACKUP_VERSION: u16 = 1;
/// Maximum embedded manifest JSON size (1 MiB).
pub const MAX_BACKUP_MANIFEST_BYTES: u32 = 1024 * 1024;
/// Maximum SQLite payload size (512 MiB).
pub const MAX_BACKUP_PAYLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Fixed binary header size preceding manifest JSON and payload bytes.
pub const BACKUP_HEADER_LEN: usize = 4 + 2 + 4 + 32 + 8;

/// Backup manifest embedded after the fixed binary header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupManifest {
    pub artifact_version: u16,
    pub schema_version: i64,
    /// ISO-8601 timestamp of backup creation.
    pub created_at: String,
    /// Hex-encoded SHA-256 of the SQLite payload bytes.
    pub payload_sha256: String,
    pub task_count: u64,
    pub project_count: u64,
    pub tag_count: u64,
    pub event_count: u64,
    pub revision: u64,
}

/// Backup envelope header preceding the SQLite payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupHeader {
    pub magic: [u8; 4],
    pub version: u16,
    pub manifest_len: u32,
    pub manifest_sha256: [u8; 32],
    pub payload_len: u64,
    // Followed by: manifest_json (manifest_len bytes), sqlite_payload (payload_len bytes)
}

/// Structured backup framing / validation failure.
#[derive(Debug, Error)]
pub enum BackupError {
    #[error("invalid magic bytes")]
    InvalidMagic,
    #[error("unsupported version {0}")]
    UnsupportedVersion(u16),
    #[error("manifest too large: {0} bytes")]
    ManifestTooLarge(u32),
    #[error("payload too large: {0} bytes")]
    PayloadTooLarge(u64),
    #[error("manifest hash mismatch")]
    ManifestHashMismatch,
    #[error("payload hash mismatch")]
    PayloadHashMismatch,
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid backup manifest: {0}")]
    InvalidManifest(String),
}

/// Write the fixed-size backup envelope header (little-endian integers).
pub fn write_backup_header(header: &BackupHeader, writer: &mut impl Write) -> io::Result<()> {
    writer.write_all(&header.magic)?;
    writer.write_all(&header.version.to_le_bytes())?;
    writer.write_all(&header.manifest_len.to_le_bytes())?;
    writer.write_all(&header.manifest_sha256)?;
    writer.write_all(&header.payload_len.to_le_bytes())?;
    Ok(())
}

/// Read the fixed-size backup envelope header (little-endian integers).
pub fn read_backup_header(reader: &mut impl Read) -> io::Result<BackupHeader> {
    let mut magic = [0u8; 4];
    reader.read_exact(&mut magic)?;
    let mut version_buf = [0u8; 2];
    reader.read_exact(&mut version_buf)?;
    let mut manifest_len_buf = [0u8; 4];
    reader.read_exact(&mut manifest_len_buf)?;
    let mut manifest_sha256 = [0u8; 32];
    reader.read_exact(&mut manifest_sha256)?;
    let mut payload_len_buf = [0u8; 8];
    reader.read_exact(&mut payload_len_buf)?;
    Ok(BackupHeader {
        magic,
        version: u16::from_le_bytes(version_buf),
        manifest_len: u32::from_le_bytes(manifest_len_buf),
        manifest_sha256,
        payload_len: u64::from_le_bytes(payload_len_buf),
    })
}

/// Validate magic, version, and declared length ceilings on a parsed header.
pub fn validate_backup_header(header: &BackupHeader) -> Result<(), BackupError> {
    if &header.magic != BACKUP_MAGIC {
        return Err(BackupError::InvalidMagic);
    }
    if header.version != BACKUP_VERSION {
        return Err(BackupError::UnsupportedVersion(header.version));
    }
    if header.manifest_len == 0 || header.manifest_len > MAX_BACKUP_MANIFEST_BYTES {
        return Err(BackupError::ManifestTooLarge(header.manifest_len));
    }
    if header.payload_len == 0 || header.payload_len > MAX_BACKUP_PAYLOAD_BYTES {
        return Err(BackupError::PayloadTooLarge(header.payload_len));
    }
    Ok(())
}

/// SHA-256 digest of raw bytes as a lowercase hex string.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_encode(&digest)
}

/// SHA-256 raw digest bytes.
#[must_use]
pub fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// Decode a lowercase or uppercase hex string into fixed-size bytes.
pub fn decode_sha256_hex(hex: &str) -> Result<[u8; 32], BackupError> {
    if hex.len() != 64 {
        return Err(BackupError::InvalidManifest(
            "payload_sha256 must be 64 hex characters".into(),
        ));
    }
    let mut out = [0u8; 32];
    for (index, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = hex_nibble(chunk[0]).ok_or_else(|| {
            BackupError::InvalidManifest("payload_sha256 contains non-hex".into())
        })?;
        let lo = hex_nibble(chunk[1]).ok_or_else(|| {
            BackupError::InvalidManifest("payload_sha256 contains non-hex".into())
        })?;
        out[index] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Parse and fully validate a `.junban-backup` envelope, returning the manifest and SQLite bytes.
pub fn parse_backup_envelope(data: &[u8]) -> Result<(BackupManifest, Vec<u8>), BackupError> {
    if data.len() < BACKUP_HEADER_LEN {
        return Err(BackupError::Io(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "backup envelope shorter than header",
        )));
    }
    let mut cursor = io::Cursor::new(data);
    let header = read_backup_header(&mut cursor)?;
    validate_backup_header(&header)?;

    let manifest_len = header.manifest_len as usize;
    let payload_len = usize::try_from(header.payload_len)
        .map_err(|_| BackupError::PayloadTooLarge(header.payload_len))?;
    let expected_total = BACKUP_HEADER_LEN
        .checked_add(manifest_len)
        .and_then(|value| value.checked_add(payload_len))
        .ok_or(BackupError::PayloadTooLarge(header.payload_len))?;
    if data.len() != expected_total {
        return Err(BackupError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "backup length {} does not match header framing {expected_total}",
                data.len()
            ),
        )));
    }

    let mut manifest_json = vec![0u8; manifest_len];
    cursor.read_exact(&mut manifest_json)?;
    if sha256_bytes(&manifest_json) != header.manifest_sha256 {
        return Err(BackupError::ManifestHashMismatch);
    }

    let mut payload = vec![0u8; payload_len];
    cursor.read_exact(&mut payload)?;

    let manifest: BackupManifest = serde_json::from_slice(&manifest_json)
        .map_err(|error| BackupError::InvalidManifest(error.to_string()))?;
    if manifest.artifact_version != BACKUP_VERSION {
        return Err(BackupError::UnsupportedVersion(manifest.artifact_version));
    }
    let expected_payload_hash = decode_sha256_hex(&manifest.payload_sha256)?;
    if sha256_bytes(&payload) != expected_payload_hash {
        return Err(BackupError::PayloadHashMismatch);
    }
    Ok((manifest, payload))
}

/// Frame a verified SQLite payload and manifest into a complete `.junban-backup` envelope.
pub fn frame_backup_envelope(
    manifest: &BackupManifest,
    payload: &[u8],
) -> Result<Vec<u8>, BackupError> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|error| BackupError::InvalidManifest(error.to_string()))?;
    let manifest_len =
        u32::try_from(manifest_json.len()).map_err(|_| BackupError::ManifestTooLarge(u32::MAX))?;
    if manifest_len == 0 || manifest_len > MAX_BACKUP_MANIFEST_BYTES {
        return Err(BackupError::ManifestTooLarge(manifest_len));
    }
    let payload_len = u64::try_from(payload.len()).unwrap_or(u64::MAX);
    if payload_len == 0 || payload_len > MAX_BACKUP_PAYLOAD_BYTES {
        return Err(BackupError::PayloadTooLarge(payload_len));
    }
    if sha256_hex(payload) != manifest.payload_sha256 {
        return Err(BackupError::PayloadHashMismatch);
    }

    let header = BackupHeader {
        magic: *BACKUP_MAGIC,
        version: BACKUP_VERSION,
        manifest_len,
        manifest_sha256: sha256_bytes(&manifest_json),
        payload_len,
    };
    let total = BACKUP_HEADER_LEN + manifest_json.len() + payload.len();
    let mut out = Vec::with_capacity(total);
    write_backup_header(&header, &mut out)?;
    out.extend_from_slice(&manifest_json);
    out.extend_from_slice(payload);
    Ok(out)
}

/// Transfer format identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferFormat {
    Json,
    Csv,
    Markdown,
    TodoistJson,
}

impl TransferFormat {
    /// Parse a wire format name (`json`, `csv`, `markdown`, `todoist_json`).
    pub fn parse(value: &str) -> Result<Self, TransferError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "json" => Ok(Self::Json),
            "csv" => Ok(Self::Csv),
            "markdown" | "md" => Ok(Self::Markdown),
            "todoist_json" | "todoist" => Ok(Self::TodoistJson),
            _ => Err(TransferError::UnsupportedFormat),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Csv => "csv",
            Self::Markdown => "markdown",
            Self::TodoistJson => "todoist_json",
        }
    }
}

/// One normalized imported item in a preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportDraft {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,
    /// ISO civil date string (`YYYY-MM-DD`) when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_names: Vec<String>,
    /// Source line number (1-based) for diagnostics; `0` when not line-oriented.
    pub line: usize,
}

/// Preview of an import before applying.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferPreview {
    pub format: TransferFormat,
    pub drafts: Vec<ImportDraft>,
    /// Distinct project names that should be created or reused.
    pub project_names: Vec<String>,
    /// Distinct tag names that should be created or reused.
    pub tag_names: Vec<String>,
    pub warnings: Vec<TransferWarning>,
    /// SHA-256 hex digest of the exact input bytes.
    pub content_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferWarning {
    pub line: usize,
    pub message: String,
}

/// Request to apply a previously previewed import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferApply {
    pub format: TransferFormat,
    pub content: String,
    /// Must match the preview fingerprint for the same content bytes.
    pub fingerprint: String,
    /// Original import name → resolved catalog name (identity when omitted).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_name_mapping: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_name_mapping: Vec<(String, String)>,
}

/// Structured transfer failure suitable for application and HTTP mapping.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TransferError {
    #[error("could not parse transfer content: {message}")]
    ParseError {
        message: String,
        line: Option<usize>,
    },
    #[error(transparent)]
    ValidationError(#[from] ValidationError),
    #[error("unsupported transfer format")]
    UnsupportedFormat,
}

impl TransferError {
    fn parse(message: impl Into<String>) -> Self {
        Self::ParseError {
            message: message.into(),
            line: None,
        }
    }

    fn parse_at(line: usize, message: impl Into<String>) -> Self {
        Self::ParseError {
            message: message.into(),
            line: Some(line),
        }
    }
}

/// SHA-256 hex fingerprint of raw transfer content.
#[must_use]
pub fn content_fingerprint(content: &str) -> String {
    sha256_hex(content.as_bytes())
}

/// Dispatch preview parsing for a supported format.
pub fn preview_transfer(
    format: TransferFormat,
    content: &str,
) -> Result<TransferPreview, TransferError> {
    match format {
        TransferFormat::Json => parse_json_transfer(content),
        TransferFormat::Csv => parse_csv_transfer(content),
        TransferFormat::Markdown => parse_markdown_transfer(content),
        TransferFormat::TodoistJson => parse_todoist_json(content),
    }
}

/// Parse Junban JSON task transfer (versioned envelope or bare task array).
pub fn parse_json_transfer(input: &str) -> Result<TransferPreview, TransferError> {
    ensure_content_bounds(input)?;
    let value: serde_json::Value =
        serde_json::from_str(input).map_err(|error| TransferError::parse(error.to_string()))?;

    let mut warnings = Vec::new();
    let tasks = match &value {
        serde_json::Value::Array(items) => items.as_slice(),
        serde_json::Value::Object(map) => {
            if let Some(format) = map.get("format").and_then(serde_json::Value::as_str)
                && format != "junban_tasks"
            {
                warnings.push(TransferWarning {
                    line: 0,
                    message: format!("unrecognized transfer format label `{format}`"),
                });
            }
            if let Some(version) = map.get("version")
                && version.as_u64() != Some(1)
            {
                warnings.push(TransferWarning {
                    line: 0,
                    message: format!(
                        "unsupported transfer version `{version}` treated as best-effort"
                    ),
                });
            }
            match map.get("tasks") {
                Some(serde_json::Value::Array(items)) => items.as_slice(),
                Some(_) => {
                    return Err(TransferError::parse(
                        "tasks must be a JSON array in junban task transfer",
                    ));
                }
                None => {
                    return Err(TransferError::parse(
                        "junban task transfer object requires a tasks array",
                    ));
                }
            }
        }
        _ => {
            return Err(TransferError::parse(
                "JSON transfer must be a task array or junban_tasks object",
            ));
        }
    };

    if tasks.len() > MAX_BULK_IDS {
        return Err(ValidationError::TooMany {
            field: "tasks",
            count: tasks.len(),
            max: MAX_BULK_IDS,
        }
        .into());
    }

    let mut drafts = Vec::with_capacity(tasks.len());
    for (index, item) in tasks.iter().enumerate() {
        let line = index + 1;
        let object = item.as_object().ok_or_else(|| {
            TransferError::parse_at(line, "each task entry must be a JSON object")
        })?;
        for key in object.keys() {
            if !JSON_TASK_KNOWN_FIELDS.contains(&key.as_str()) {
                warnings.push(TransferWarning {
                    line,
                    message: format!("ignored unknown field `{key}`"),
                });
            }
        }
        let title = required_string(object, "title", line)?;
        validate_title_len(&title, line)?;
        let description = optional_string(object, "description");
        if let Some(text) = description.as_ref() {
            validate_description_len(text, line)?;
        }
        let priority = optional_priority(object.get("priority"), line, &mut warnings)?;
        let due_date = optional_due_date(object.get("due_date"), line, &mut warnings)?;
        let project_name =
            optional_string(object, "project").or_else(|| optional_string(object, "project_name"));
        let tag_names = read_string_list(object.get("tags"), line)?;
        drafts.push(ImportDraft {
            title,
            description,
            priority,
            due_date,
            project_name,
            tag_names,
            line,
        });
    }

    Ok(finish_preview(
        TransferFormat::Json,
        drafts,
        warnings,
        input,
    ))
}

/// Parse strict CSV with columns: title,description,priority,due_date,project,tags.
pub fn parse_csv_transfer(input: &str) -> Result<TransferPreview, TransferError> {
    ensure_content_bounds(input)?;
    let rows = parse_csv_rows(input)?;
    if rows.is_empty() {
        return Err(TransferError::parse("CSV transfer requires a header row"));
    }

    let header = normalize_csv_header(&rows[0]);
    let expected = [
        "title",
        "description",
        "priority",
        "due_date",
        "project",
        "tags",
    ];
    if header.len() != expected.len() || header.iter().zip(expected).any(|(a, b)| a != b) {
        return Err(TransferError::parse(format!(
            "CSV header must be exactly {}",
            expected.join(",")
        )));
    }

    if rows.len() - 1 > MAX_BULK_IDS {
        return Err(ValidationError::TooMany {
            field: "tasks",
            count: rows.len() - 1,
            max: MAX_BULK_IDS,
        }
        .into());
    }

    let mut drafts = Vec::new();
    let mut warnings = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(1) {
        let line = index + 1;
        if row.iter().all(|cell| cell.trim().is_empty()) {
            continue;
        }
        if row.len() != expected.len() {
            return Err(TransferError::parse_at(
                line,
                format!("expected {} columns, found {}", expected.len(), row.len()),
            ));
        }
        let title = row[0].trim();
        if title.is_empty() {
            warnings.push(TransferWarning {
                line,
                message: "skipped row with empty title".into(),
            });
            continue;
        }
        validate_title_len(title, line)?;
        let description = {
            let value = row[1].trim();
            if value.is_empty() {
                None
            } else {
                validate_description_len(value, line)?;
                Some(value.to_owned())
            }
        };
        let priority = parse_priority_cell(&row[2], line, &mut warnings)?;
        let due_date = parse_due_date_cell(&row[3], line, &mut warnings)?;
        let project_name = {
            let value = row[4].trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_owned())
            }
        };
        let tag_names = split_tag_list(&row[5]);
        drafts.push(ImportDraft {
            title: title.to_owned(),
            description,
            priority,
            due_date,
            project_name,
            tag_names,
            line,
        });
    }

    Ok(finish_preview(TransferFormat::Csv, drafts, warnings, input))
}

/// Extract tasks from Markdown checklist / bullet / plain lines.
pub fn parse_markdown_transfer(input: &str) -> Result<TransferPreview, TransferError> {
    ensure_content_bounds(input)?;
    // Reuse the Phase 2 pure line parser, then project into transfer drafts.
    let text_drafts = parse_text_import(input).map_err(TransferError::from)?;
    if text_drafts.len() > MAX_BULK_IDS {
        return Err(ValidationError::TooMany {
            field: "tasks",
            count: text_drafts.len(),
            max: MAX_BULK_IDS,
        }
        .into());
    }

    let mut drafts = Vec::with_capacity(text_drafts.len());
    let mut warnings = Vec::new();
    let mut line_no = 0usize;
    for draft in text_drafts {
        // Approximate source line by scanning non-empty structural lines again.
        line_no = next_task_line(input, line_no).unwrap_or(line_no + 1);
        if draft.completed {
            warnings.push(TransferWarning {
                line: line_no,
                message:
                    "checked checkbox imported as a pending task (completion is not transferred)"
                        .into(),
            });
        }
        drafts.push(ImportDraft {
            title: draft.title.to_string(),
            description: None,
            priority: None,
            due_date: None,
            project_name: None,
            tag_names: Vec::new(),
            line: line_no,
        });
    }

    Ok(finish_preview(
        TransferFormat::Markdown,
        drafts,
        warnings,
        input,
    ))
}

/// Bounded Todoist-style JSON projection. Unknown fields become warnings.
pub fn parse_todoist_json(input: &str) -> Result<TransferPreview, TransferError> {
    ensure_content_bounds(input)?;
    let root: serde_json::Value =
        serde_json::from_str(input).map_err(|error| TransferError::parse(error.to_string()))?;
    let object = root
        .as_object()
        .ok_or_else(|| TransferError::parse("Todoist JSON root must be an object"))?;

    let mut warnings = Vec::new();
    for key in object.keys() {
        if !TODOIST_ROOT_KNOWN_FIELDS.contains(&key.as_str()) {
            warnings.push(TransferWarning {
                line: 0,
                message: format!("ignored unknown root field `{key}`"),
            });
        }
    }

    let project_names_by_id = todoist_name_map(object.get("projects"), "name", &mut warnings);
    let label_names_by_id = todoist_name_map(object.get("labels"), "name", &mut warnings);

    let items = match object.get("items") {
        Some(serde_json::Value::Array(items)) => items.as_slice(),
        Some(_) => {
            return Err(TransferError::parse("Todoist items must be a JSON array"));
        }
        None => {
            return Err(TransferError::parse("Todoist JSON requires an items array"));
        }
    };

    if items.len() > MAX_BULK_IDS {
        return Err(ValidationError::TooMany {
            field: "tasks",
            count: items.len(),
            max: MAX_BULK_IDS,
        }
        .into());
    }

    let mut drafts = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let line = index + 1;
        let Some(map) = item.as_object() else {
            warnings.push(TransferWarning {
                line,
                message: "skipped non-object item".into(),
            });
            continue;
        };
        for key in map.keys() {
            if !TODOIST_ITEM_KNOWN_FIELDS.contains(&key.as_str()) {
                warnings.push(TransferWarning {
                    line,
                    message: format!("ignored unknown item field `{key}`"),
                });
            }
        }
        let title = match map.get("content").and_then(serde_json::Value::as_str) {
            Some(value) if !value.trim().is_empty() => value.trim().to_owned(),
            _ => {
                warnings.push(TransferWarning {
                    line,
                    message: "skipped item without content".into(),
                });
                continue;
            }
        };
        validate_title_len(&title, line)?;
        let description = map
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        if let Some(text) = description.as_ref() {
            validate_description_len(text, line)?;
        }
        let priority = map
            .get("priority")
            .and_then(serde_json::Value::as_u64)
            .and_then(|value| {
                // Todoist: 4 = urgent … 1 = normal. Junban: 1 = highest … 4 = lowest.
                let mapped = match value {
                    4 => 1,
                    3 => 2,
                    2 => 3,
                    1 => 4,
                    other => {
                        warnings.push(TransferWarning {
                            line,
                            message: format!("ignored out-of-range Todoist priority {other}"),
                        });
                        return None;
                    }
                };
                Priority::new(mapped).ok()
            });
        let due_date = map.get("due").and_then(|due| {
            let date = match due {
                serde_json::Value::Object(due_obj) => due_obj
                    .get("date")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                serde_json::Value::String(raw) => Some(raw.clone()),
                _ => None,
            }?;
            match parse_iso_date(&date) {
                Ok(normalized) => Some(normalized),
                Err(message) => {
                    warnings.push(TransferWarning {
                        line,
                        message: format!("ignored invalid due date: {message}"),
                    });
                    None
                }
            }
        });
        let project_name = map.get("project_id").and_then(|value| match value {
            serde_json::Value::String(id) => project_names_by_id.get(id).cloned(),
            serde_json::Value::Number(num) => project_names_by_id.get(&num.to_string()).cloned(),
            _ => None,
        });
        let mut tag_names = Vec::new();
        if let Some(labels) = map.get("labels").and_then(serde_json::Value::as_array) {
            for label in labels {
                match label {
                    serde_json::Value::String(name) if !name.trim().is_empty() => {
                        // Prefer direct label names; fall back to id lookup.
                        if let Some(resolved) = label_names_by_id.get(name) {
                            tag_names.push(resolved.clone());
                        } else {
                            tag_names.push(name.trim().to_owned());
                        }
                    }
                    serde_json::Value::Number(num) => {
                        if let Some(resolved) = label_names_by_id.get(&num.to_string()) {
                            tag_names.push(resolved.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        drafts.push(ImportDraft {
            title,
            description,
            priority,
            due_date,
            project_name,
            tag_names,
            line,
        });
    }

    Ok(finish_preview(
        TransferFormat::TodoistJson,
        drafts,
        warnings,
        input,
    ))
}

/// True when `apply` carries the same content fingerprint as `preview` and re-parses identically.
#[must_use]
pub fn validate_preview_matches_apply(preview: &TransferPreview, apply: &TransferApply) -> bool {
    if preview.format != apply.format {
        return false;
    }
    if preview.content_fingerprint != apply.fingerprint {
        return false;
    }
    if content_fingerprint(&apply.content) != apply.fingerprint {
        return false;
    }
    match preview_transfer(apply.format, &apply.content) {
        Ok(fresh) => {
            fresh.content_fingerprint == preview.content_fingerprint
                && fresh.drafts == preview.drafts
                && fresh.project_names == preview.project_names
                && fresh.tag_names == preview.tag_names
        }
        Err(_) => false,
    }
}

/// Export tasks as a versioned Junban JSON transfer document.
#[must_use]
pub fn export_tasks_json(tasks: &[Task], projects: &[Project], tags: &[Tag]) -> String {
    let project_names: BTreeMap<_, _> = projects
        .iter()
        .map(|project| (project.id, project.name.as_str().to_owned()))
        .collect();
    let tag_names: BTreeMap<_, _> = tags
        .iter()
        .map(|tag| (tag.id, tag.name.as_str().to_owned()))
        .collect();

    let mut task_entries = Vec::with_capacity(tasks.len());
    for task in tasks {
        let mut entry = serde_json::Map::new();
        entry.insert(
            "title".into(),
            serde_json::Value::String(task.title.as_str().to_owned()),
        );
        if !task.description.is_empty() {
            entry.insert(
                "description".into(),
                serde_json::Value::String(task.description.as_str().to_owned()),
            );
        }
        if let Some(priority) = task.priority {
            entry.insert(
                "priority".into(),
                serde_json::Value::Number(priority.get().into()),
            );
        }
        if let Some(due) = task.due_date {
            entry.insert(
                "due_date".into(),
                serde_json::Value::String(due.to_string()),
            );
        }
        if let Some(project_id) = task.project_id
            && let Some(name) = project_names.get(&project_id)
        {
            entry.insert("project".into(), serde_json::Value::String(name.clone()));
        }
        if !task.tag_ids.is_empty() {
            let names: Vec<serde_json::Value> = task
                .tag_ids
                .iter()
                .filter_map(|id| tag_names.get(id).cloned())
                .map(serde_json::Value::String)
                .collect();
            if !names.is_empty() {
                entry.insert("tags".into(), serde_json::Value::Array(names));
            }
        }
        task_entries.push(serde_json::Value::Object(entry));
    }

    let mut used_projects = BTreeSet::new();
    let mut used_tags = BTreeSet::new();
    for task in tasks {
        if let Some(project_id) = task.project_id
            && let Some(name) = project_names.get(&project_id)
        {
            used_projects.insert(name.clone());
        }
        for tag_id in &task.tag_ids {
            if let Some(name) = tag_names.get(tag_id) {
                used_tags.insert(name.clone());
            }
        }
    }

    let doc = serde_json::json!({
        "format": "junban_tasks",
        "version": 1,
        "projects": used_projects.into_iter().map(|name| serde_json::json!({ "name": name })).collect::<Vec<_>>(),
        "tags": used_tags.into_iter().map(|name| serde_json::json!({ "name": name })).collect::<Vec<_>>(),
        "tasks": task_entries,
    });
    // Stable pretty JSON for human-readable transfer.
    let mut out = serde_json::to_string_pretty(&doc).unwrap_or_else(|_| "{}".into());
    out.push('\n');
    out
}

/// Export tasks as strict CSV with the documented column set.
#[must_use]
pub fn export_tasks_csv(tasks: &[Task]) -> String {
    // Name resolution is intentionally omitted here; callers that need names should
    // prefer JSON export or pass already-projected rows. CSV export uses blank project/tags
    // when only tasks are available — the service layer resolves names before calling
    // [`export_tasks_csv_with_names`].
    export_tasks_csv_with_names(tasks, &BTreeMap::new(), &BTreeMap::new())
}

/// CSV export with project/tag id → name maps.
#[must_use]
pub fn export_tasks_csv_with_names(
    tasks: &[Task],
    project_names: &BTreeMap<crate::ProjectId, String>,
    tag_names: &BTreeMap<crate::TagId, String>,
) -> String {
    let mut out = String::from("title,description,priority,due_date,project,tags\n");
    for task in tasks {
        let priority = task
            .priority
            .map(|value| value.get().to_string())
            .unwrap_or_default();
        let due = task
            .due_date
            .map(|value| value.to_string())
            .unwrap_or_default();
        let project = task
            .project_id
            .and_then(|id| project_names.get(&id).cloned())
            .unwrap_or_default();
        let tags = task
            .tag_ids
            .iter()
            .filter_map(|id| tag_names.get(id).cloned())
            .collect::<Vec<_>>()
            .join(",");
        push_csv_row(
            &mut out,
            &[
                task.title.as_str(),
                task.description.as_str(),
                &priority,
                &due,
                &project,
                &tags,
            ],
        );
    }
    out
}

/// Export tasks as Markdown checklist lines.
#[must_use]
pub fn export_tasks_markdown(tasks: &[Task]) -> String {
    let mut out = String::new();
    for task in tasks {
        let mark = match task.status {
            TaskStatus::Completed => "x",
            TaskStatus::Pending | TaskStatus::Cancelled => " ",
        };
        out.push_str("- [");
        out.push_str(mark);
        out.push_str("] ");
        out.push_str(task.title.as_str());
        out.push('\n');
        if !task.description.is_empty() {
            for line in task.description.as_str().lines() {
                out.push_str("  ");
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out
}

/// Validate and convert one preview draft into domain value objects for persistence.
pub fn draft_to_task_fields(
    draft: &ImportDraft,
) -> Result<(TaskTitle, MarkdownText, Option<Priority>, Option<Date>), TransferError> {
    let title = TaskTitle::new(draft.title.clone())?;
    let description = match draft.description.as_deref() {
        Some(text) if !text.is_empty() => MarkdownText::new(text.to_owned())?,
        _ => MarkdownText::empty(),
    };
    let due_date = match draft.due_date.as_deref() {
        Some(raw) if !raw.is_empty() => {
            Some(
                Date::strptime("%Y-%m-%d", raw).map_err(|_| ValidationError::InvalidFormat {
                    field: "due_date",
                    expected: "YYYY-MM-DD",
                })?,
            )
        }
        _ => None,
    };
    Ok((title, description, draft.priority, due_date))
}

const JSON_TASK_KNOWN_FIELDS: &[&str] = &[
    "title",
    "description",
    "priority",
    "due_date",
    "project",
    "project_name",
    "tags",
];

const TODOIST_ROOT_KNOWN_FIELDS: &[&str] = &[
    "items", "projects", "labels", "notes", "sections", "filters", "version",
];

const TODOIST_ITEM_KNOWN_FIELDS: &[&str] = &[
    "id",
    "content",
    "description",
    "priority",
    "due",
    "project_id",
    "labels",
    "checked",
    "is_deleted",
    "parent_id",
    "section_id",
    "order",
    "child_order",
];

fn ensure_content_bounds(input: &str) -> Result<(), TransferError> {
    if input.len() > MAX_TRANSFER_CONTENT_BYTES {
        return Err(ValidationError::TooLong {
            field: "content",
            max: MAX_TRANSFER_CONTENT_BYTES,
        }
        .into());
    }
    Ok(())
}

fn finish_preview(
    format: TransferFormat,
    drafts: Vec<ImportDraft>,
    warnings: Vec<TransferWarning>,
    content: &str,
) -> TransferPreview {
    let mut project_names = BTreeSet::new();
    let mut tag_names = BTreeSet::new();
    for draft in &drafts {
        if let Some(name) = draft.project_name.as_ref() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                project_names.insert(trimmed.to_owned());
            }
        }
        for tag in &draft.tag_names {
            let trimmed = tag.trim();
            if !trimmed.is_empty() {
                tag_names.insert(trimmed.to_owned());
            }
        }
    }
    TransferPreview {
        format,
        drafts,
        project_names: project_names.into_iter().collect(),
        tag_names: tag_names.into_iter().collect(),
        warnings,
        content_fingerprint: content_fingerprint(content),
    }
}

fn required_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    line: usize,
) -> Result<String, TransferError> {
    match object.get(key).and_then(serde_json::Value::as_str) {
        Some(value) if !value.trim().is_empty() => Ok(value.trim().to_owned()),
        Some(_) => Err(TransferError::parse_at(
            line,
            format!("{key} must not be empty"),
        )),
        None => Err(TransferError::parse_at(
            line,
            format!("missing required field `{key}`"),
        )),
    }
}

fn optional_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn read_string_list(
    value: Option<&serde_json::Value>,
    line: usize,
) -> Result<Vec<String>, TransferError> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(items)) => {
            let mut names = Vec::new();
            for item in items {
                match item.as_str() {
                    Some(name) if !name.trim().is_empty() => names.push(name.trim().to_owned()),
                    Some(_) => {}
                    None => {
                        return Err(TransferError::parse_at(
                            line,
                            "tags entries must be strings",
                        ));
                    }
                }
            }
            Ok(names)
        }
        Some(serde_json::Value::String(raw)) => Ok(split_tag_list(raw)),
        Some(_) => Err(TransferError::parse_at(
            line,
            "tags must be an array of strings or a comma-separated string",
        )),
    }
}

fn optional_priority(
    value: Option<&serde_json::Value>,
    line: usize,
    warnings: &mut Vec<TransferWarning>,
) -> Result<Option<Priority>, TransferError> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(num)) => {
            let Some(raw) = num.as_u64() else {
                warnings.push(TransferWarning {
                    line,
                    message: "ignored non-integer priority".into(),
                });
                return Ok(None);
            };
            let Ok(byte) = u8::try_from(raw) else {
                warnings.push(TransferWarning {
                    line,
                    message: format!("ignored out-of-range priority {raw}"),
                });
                return Ok(None);
            };
            match Priority::new(byte) {
                Ok(priority) => Ok(Some(priority)),
                Err(_) => {
                    warnings.push(TransferWarning {
                        line,
                        message: format!("ignored out-of-range priority {raw}"),
                    });
                    Ok(None)
                }
            }
        }
        Some(serde_json::Value::String(raw)) => Ok(parse_priority_cell(raw, line, warnings)?),
        Some(_) => {
            warnings.push(TransferWarning {
                line,
                message: "ignored non-numeric priority".into(),
            });
            Ok(None)
        }
    }
}

fn optional_due_date(
    value: Option<&serde_json::Value>,
    line: usize,
    warnings: &mut Vec<TransferWarning>,
) -> Result<Option<String>, TransferError> {
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(raw)) if raw.trim().is_empty() => Ok(None),
        Some(serde_json::Value::String(raw)) => match parse_iso_date(raw.trim()) {
            Ok(date) => Ok(Some(date)),
            Err(message) => {
                warnings.push(TransferWarning {
                    line,
                    message: format!("ignored invalid due_date: {message}"),
                });
                Ok(None)
            }
        },
        Some(_) => {
            warnings.push(TransferWarning {
                line,
                message: "ignored non-string due_date".into(),
            });
            Ok(None)
        }
    }
}

fn parse_priority_cell(
    raw: &str,
    line: usize,
    warnings: &mut Vec<TransferWarning>,
) -> Result<Option<Priority>, TransferError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let normalized = trimmed
        .strip_prefix('P')
        .or_else(|| trimmed.strip_prefix('p'))
        .unwrap_or(trimmed);
    match normalized.parse::<u8>() {
        Ok(value) => match Priority::new(value) {
            Ok(priority) => Ok(Some(priority)),
            Err(_) => {
                warnings.push(TransferWarning {
                    line,
                    message: format!("ignored out-of-range priority `{trimmed}`"),
                });
                Ok(None)
            }
        },
        Err(_) => {
            warnings.push(TransferWarning {
                line,
                message: format!("ignored non-numeric priority `{trimmed}`"),
            });
            Ok(None)
        }
    }
}

fn parse_due_date_cell(
    raw: &str,
    line: usize,
    warnings: &mut Vec<TransferWarning>,
) -> Result<Option<String>, TransferError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    match parse_iso_date(trimmed) {
        Ok(date) => Ok(Some(date)),
        Err(message) => {
            warnings.push(TransferWarning {
                line,
                message: format!("ignored invalid due_date: {message}"),
            });
            Ok(None)
        }
    }
}

fn parse_iso_date(raw: &str) -> Result<String, String> {
    // Accept full ISO date or date-time prefix `YYYY-MM-DD…`.
    let date_part = raw.split('T').next().unwrap_or(raw).trim();
    Date::strptime("%Y-%m-%d", date_part)
        .map(|date| date.to_string())
        .map_err(|_| format!("expected YYYY-MM-DD, got `{raw}`"))
}

fn validate_title_len(title: &str, line: usize) -> Result<(), TransferError> {
    if title.chars().count() > MAX_TASK_TITLE_CHARS {
        return Err(TransferError::parse_at(
            line,
            format!("title exceeds {MAX_TASK_TITLE_CHARS} characters"),
        ));
    }
    Ok(())
}

fn validate_description_len(text: &str, line: usize) -> Result<(), TransferError> {
    if text.chars().count() > MAX_MARKDOWN_CHARS {
        return Err(TransferError::parse_at(
            line,
            format!("description exceeds {MAX_MARKDOWN_CHARS} characters"),
        ));
    }
    Ok(())
}

fn split_tag_list(raw: &str) -> Vec<String> {
    raw.split([',', ';'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn todoist_name_map(
    value: Option<&serde_json::Value>,
    name_key: &str,
    warnings: &mut Vec<TransferWarning>,
) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let Some(serde_json::Value::Array(items)) = value else {
        return map;
    };
    for (index, item) in items.iter().enumerate() {
        let Some(object) = item.as_object() else {
            warnings.push(TransferWarning {
                line: index + 1,
                message: format!("ignored non-object entry in {name_key} catalog"),
            });
            continue;
        };
        let id = match object.get("id") {
            Some(serde_json::Value::String(id)) => id.clone(),
            Some(serde_json::Value::Number(num)) => num.to_string(),
            _ => continue,
        };
        if let Some(name) = object
            .get(name_key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            map.insert(id, name.to_owned());
        }
    }
    map
}

fn next_task_line(input: &str, after: usize) -> Option<usize> {
    for (index, line) in input.lines().enumerate() {
        let line_no = index + 1;
        if line_no <= after {
            continue;
        }
        if line_looks_like_task(line) {
            return Some(line_no);
        }
    }
    None
}

fn line_looks_like_task(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    let body = if matches!(line.chars().next(), Some('-' | '*' | '+')) {
        line[line.chars().next().map_or(0, char::len_utf8)..].trim_start()
    } else {
        line
    };
    if body == "[ ]" || body == "[x]" || body == "[X]" {
        return false;
    }
    if let Some(rest) = body
        .strip_prefix("[ ]")
        .or_else(|| body.strip_prefix("[x]"))
        .or_else(|| body.strip_prefix("[X]"))
    {
        return !rest.trim_start().is_empty();
    }
    !body.is_empty()
}

fn normalize_csv_header(row: &[String]) -> Vec<String> {
    row.iter()
        .map(|cell| cell.trim().to_ascii_lowercase())
        .collect()
}

/// RFC 4180-ish CSV parser with strict double-quote escaping.
fn parse_csv_rows(input: &str) -> Result<Vec<Vec<String>>, TransferError> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = input.chars().peekable();
    let mut in_quotes = false;
    let mut line = 1usize;
    let mut saw_field = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                saw_field = true;
                if in_quotes {
                    if chars.peek() == Some(&'"') {
                        field.push('"');
                        chars.next();
                    } else {
                        in_quotes = false;
                    }
                } else if field.is_empty() {
                    in_quotes = true;
                } else {
                    return Err(TransferError::parse_at(
                        line,
                        "unexpected quote inside unquoted CSV field",
                    ));
                }
            }
            ',' if !in_quotes => {
                row.push(std::mem::take(&mut field));
                saw_field = true;
            }
            '\n' if !in_quotes => {
                if saw_field || !field.is_empty() || !row.is_empty() {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                saw_field = false;
                line += 1;
            }
            '\r' if !in_quotes => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                if saw_field || !field.is_empty() || !row.is_empty() {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                saw_field = false;
                line += 1;
            }
            _ => {
                if ch == '\n' {
                    line += 1;
                }
                field.push(ch);
                saw_field = true;
            }
        }
    }

    if in_quotes {
        return Err(TransferError::parse_at(
            line,
            "unterminated quoted CSV field",
        ));
    }
    if saw_field || !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    Ok(rows)
}

fn push_csv_row(out: &mut String, fields: &[&str]) {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        if needs_csv_quotes(field) {
            out.push('"');
            for ch in field.chars() {
                if ch == '"' {
                    out.push('"');
                }
                out.push(ch);
            }
            out.push('"');
        } else {
            out.push_str(field);
        }
    }
    out.push('\n');
}

fn needs_csv_quotes(value: &str) -> bool {
    value.contains([',', '"', '\n', '\r'])
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EntityName, HexColor, ProjectId, TagId, TagName, TaskId, TaskTitle};
    use jiff::Timestamp;

    #[test]
    fn json_transfer_round_trip_fingerprint() {
        let input = r#"{
  "format": "junban_tasks",
  "version": 1,
  "tasks": [
    {"title": "One", "priority": 1, "project": "Work", "tags": ["a", "b"]},
    {"title": "Two", "due_date": "2026-08-01", "description": "notes"}
  ]
}"#;
        let preview = parse_json_transfer(input).unwrap();
        assert_eq!(preview.drafts.len(), 2);
        assert_eq!(preview.project_names, vec!["Work".to_owned()]);
        assert_eq!(preview.tag_names, vec!["a".to_owned(), "b".to_owned()]);
        assert_eq!(preview.content_fingerprint, content_fingerprint(input));
        assert_eq!(preview.drafts[0].priority.unwrap().get(), 1);
        assert_eq!(preview.drafts[1].due_date.as_deref(), Some("2026-08-01"));
    }

    #[test]
    fn csv_requires_exact_header_and_quotes() {
        let input = "title,description,priority,due_date,project,tags\n\"Hello, world\",,2,2026-01-02,Inbox,\"x,y\"\n";
        let preview = parse_csv_transfer(input).unwrap();
        assert_eq!(preview.drafts.len(), 1);
        assert_eq!(preview.drafts[0].title, "Hello, world");
        assert_eq!(
            preview.drafts[0].tag_names,
            vec!["x".to_owned(), "y".to_owned()]
        );
        assert!(parse_csv_transfer("title,description\nA,B\n").is_err());
    }

    #[test]
    fn markdown_reuses_line_import_semantics() {
        let preview = parse_markdown_transfer("- [ ] open\n- [x] done\nplain\n").unwrap();
        assert_eq!(preview.drafts.len(), 3);
        assert_eq!(preview.drafts[0].title, "open");
        assert_eq!(preview.drafts[1].title, "done");
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.message.contains("checked checkbox"))
        );
    }

    #[test]
    fn todoist_maps_priority_and_reports_unknown_fields() {
        let input = r#"{
          "extra_root": true,
          "projects": [{"id": "10", "name": "Work"}],
          "labels": [{"id": "1", "name": "focus"}],
          "items": [{
            "content": "Ship",
            "priority": 4,
            "project_id": "10",
            "labels": ["focus"],
            "mystery": 1,
            "due": {"date": "2026-09-01"}
          }]
        }"#;
        let preview = parse_todoist_json(input).unwrap();
        assert_eq!(preview.drafts.len(), 1);
        assert_eq!(preview.drafts[0].priority.unwrap().get(), 1);
        assert_eq!(preview.drafts[0].project_name.as_deref(), Some("Work"));
        assert_eq!(preview.drafts[0].tag_names, vec!["focus".to_owned()]);
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.message.contains("extra_root"))
        );
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.message.contains("mystery"))
        );
    }

    #[test]
    fn apply_validation_requires_matching_fingerprint() {
        let content = "- [ ] one\n";
        let preview = parse_markdown_transfer(content).unwrap();
        let apply = TransferApply {
            format: TransferFormat::Markdown,
            content: content.into(),
            fingerprint: preview.content_fingerprint.clone(),
            project_name_mapping: Vec::new(),
            tag_name_mapping: Vec::new(),
        };
        assert!(validate_preview_matches_apply(&preview, &apply));
        let mut bad = apply.clone();
        bad.fingerprint = "0".repeat(64);
        assert!(!validate_preview_matches_apply(&preview, &bad));
    }

    #[test]
    fn export_json_is_parseable() {
        let now = Timestamp::from_second(1_700_000_000).unwrap();
        let project_id = ProjectId::new();
        let tag_id = TagId::new();
        let mut task = Task::new(
            TaskId::new(),
            TaskTitle::new("Alpha").unwrap(),
            None,
            now,
            1,
        );
        task.project_id = Some(project_id);
        task.tag_ids = vec![tag_id];
        task.priority = Some(Priority::new(2).unwrap());
        let projects = vec![Project::new(
            project_id,
            EntityName::new("Work").unwrap(),
            HexColor::new("#112233").unwrap(),
            now,
        )];
        let tags = vec![Tag::new(
            tag_id,
            TagName::new("focus").unwrap(),
            HexColor::new("#abcdef").unwrap(),
            now,
        )];
        let json = export_tasks_json(&[task], &projects, &tags);
        let preview = parse_json_transfer(&json).unwrap();
        assert_eq!(preview.drafts.len(), 1);
        assert_eq!(preview.drafts[0].title, "Alpha");
        assert_eq!(preview.project_names, vec!["Work".to_owned()]);
    }

    #[test]
    fn rejects_more_than_bulk_ceiling() {
        let mut tasks = Vec::new();
        for index in 0..=MAX_BULK_IDS {
            tasks.push(format!(r#"{{"title":"t{index}"}}"#));
        }
        let input = format!("[{}]", tasks.join(","));
        let err = parse_json_transfer(&input).unwrap_err();
        assert!(matches!(
            err,
            TransferError::ValidationError(ValidationError::TooMany { .. })
        ));
    }

    #[test]
    fn backup_envelope_round_trip_and_hash_guards() {
        let payload = b"sqlite-bytes-not-real".to_vec();
        let manifest = BackupManifest {
            artifact_version: BACKUP_VERSION,
            schema_version: 6,
            created_at: "2026-03-22T12:00:00Z".into(),
            payload_sha256: sha256_hex(&payload),
            task_count: 1,
            project_count: 0,
            tag_count: 0,
            event_count: 0,
            revision: 3,
        };
        let framed = frame_backup_envelope(&manifest, &payload).unwrap();
        let (parsed, restored_payload) = parse_backup_envelope(&framed).unwrap();
        assert_eq!(parsed, manifest);
        assert_eq!(restored_payload, payload);

        let mut bad_magic = framed.clone();
        bad_magic[0] = b'X';
        assert!(matches!(
            parse_backup_envelope(&bad_magic).unwrap_err(),
            BackupError::InvalidMagic
        ));

        let mut bad_payload = framed.clone();
        *bad_payload.last_mut().unwrap() ^= 0xff;
        assert!(matches!(
            parse_backup_envelope(&bad_payload).unwrap_err(),
            BackupError::PayloadHashMismatch
        ));
    }

    #[test]
    fn backup_header_rejects_oversize_and_bad_version() {
        let header = BackupHeader {
            magic: *BACKUP_MAGIC,
            version: 99,
            manifest_len: 10,
            manifest_sha256: [0; 32],
            payload_len: 10,
        };
        assert!(matches!(
            validate_backup_header(&header).unwrap_err(),
            BackupError::UnsupportedVersion(99)
        ));

        let oversized = BackupHeader {
            version: BACKUP_VERSION,
            payload_len: MAX_BACKUP_PAYLOAD_BYTES + 1,
            ..header
        };
        assert!(matches!(
            validate_backup_header(&oversized).unwrap_err(),
            BackupError::PayloadTooLarge(_)
        ));
    }
}
