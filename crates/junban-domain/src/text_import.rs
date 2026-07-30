//! Pure text/Markdown line import boundary.
//!
//! Every non-empty plain line, bullet, or checkbox line is one task draft. The
//! boundary intentionally does not infer hierarchy or descriptions from
//! indentation; the full import preview and mapping workflow belongs to Phase 4.

use serde::{Deserialize, Serialize};

use crate::{MarkdownText, TaskTitle, ValidationError};

/// Maximum characters accepted for one import payload.
pub const MAX_TEXT_IMPORT_CHARS: usize = 100_000;

/// One imported task draft before persistence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextImportDraft {
    pub title: TaskTitle,
    /// Explicit completion intent from a checked checkbox. No timestamp is made here.
    pub completed: bool,
    pub description: MarkdownText,
}

/// Parse a multi-line plain/Markdown task list into drafts without side effects.
pub fn parse_text_import(input: &str) -> Result<Vec<TextImportDraft>, ValidationError> {
    if input.chars().count() > MAX_TEXT_IMPORT_CHARS {
        return Err(ValidationError::TooLong {
            field: "input",
            max: MAX_TEXT_IMPORT_CHARS,
        });
    }

    input
        .lines()
        .filter_map(parse_task_line)
        .map(|(completed, title)| {
            Ok(TextImportDraft {
                title: TaskTitle::new(title)?,
                completed,
                description: MarkdownText::empty(),
            })
        })
        .collect()
}

/// Returns `(completed, title)` for one non-empty structural task line.
fn parse_task_line(line: &str) -> Option<(bool, &str)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let mut chars = line.chars();
    let first = chars.next()?;
    let body = if matches!(first, '-' | '*' | '+') {
        let rest = chars.as_str();
        if rest.starts_with(|ch: char| ch.is_whitespace()) {
            rest.trim_start()
        } else {
            line
        }
    } else {
        line
    };

    if let Some(rest) = body.strip_prefix("[ ]") {
        return non_empty_title(false, rest);
    }
    if let Some(rest) = body
        .strip_prefix("[x]")
        .or_else(|| body.strip_prefix("[X]"))
    {
        return non_empty_title(true, rest);
    }
    non_empty_title(false, body)
}

fn non_empty_title(completed: bool, title: &str) -> Option<(bool, &str)> {
    let title = title.trim_start();
    (!title.is_empty()).then_some((completed, title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_bullets_and_checkboxes() {
        let drafts = parse_text_import(
            r"
plain one
- bullet
* star
+ plus
- [ ] open
- [x] done
- [X] also done
",
        )
        .unwrap();
        assert_eq!(drafts.len(), 7);
        assert_eq!(drafts[0].title.as_str(), "plain one");
        assert_eq!(drafts[4].title.as_str(), "open");
        assert!(!drafts[4].completed);
        assert_eq!(drafts[5].title.as_str(), "done");
        assert!(drafts[5].completed);
        assert!(drafts[5].description.is_empty());
        assert!(drafts[6].completed);
    }

    #[test]
    fn indentation_does_not_invent_description_or_hierarchy() {
        let drafts =
            parse_text_import("- Parent\n  - Nested-looking line\n  continuation\n").unwrap();
        assert_eq!(drafts.len(), 3);
        assert_eq!(drafts[0].title.as_str(), "Parent");
        assert_eq!(drafts[1].title.as_str(), "Nested-looking line");
        assert_eq!(drafts[2].title.as_str(), "continuation");
        assert!(drafts.iter().all(|draft| draft.description.is_empty()));
    }

    #[test]
    fn skips_empty_structural_lines_and_rejects_oversized_input() {
        let drafts = parse_text_import("- [ ]\n-\n\n- real\n").unwrap();
        assert_eq!(drafts.len(), 2);
        assert_eq!(drafts[0].title.as_str(), "-");
        assert_eq!(drafts[1].title.as_str(), "real");

        let huge = "a".repeat(MAX_TEXT_IMPORT_CHARS + 1);
        assert_eq!(parse_text_import(&huge).unwrap_err().field(), "input");
    }

    #[test]
    fn unicode_lines_round_trip() {
        let drafts = parse_text_import("- [x] 日本語タスク\n").unwrap();
        assert_eq!(drafts[0].title.as_str(), "日本語タスク");
        assert!(drafts[0].completed);
    }
}
