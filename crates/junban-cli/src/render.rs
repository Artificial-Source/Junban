//! Concise human-facing stdout for ergonomic CLI commands.
//!
//! `--json` and generic `tool call` stay machine-oriented. This module only
//! shapes ordinary human success output: one compact mutation line, tabular
//! lists, and short planning/data summaries. It never dumps full snapshots or
//! secret-bearing fields.

use serde_json::Value;

use crate::error::CliError;
use crate::output;

/// Interpretation hint when one JSON shape backs several ergonomic commands.
///
/// Planning and motivation commands pass an explicit variant so production
/// response shapes are never misclassified by key overlap (for example weekly
/// reviews also carry `overdue_tasks`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HumanView {
    /// Infer the best concise layout from object keys.
    #[default]
    Auto,
    /// Organization catalog restricted to projects.
    Projects,
    /// Organization catalog restricted to tags.
    Tags,
    /// Machine-oriented pretty JSON (`junban tool call` only).
    PrettyJson,
    /// `plan daily` / `planning_daily`.
    DailyPlan,
    /// `plan end-of-day` / `planning_end_of_day`.
    EndOfDay,
    /// `plan weekly` / `planning_weekly`.
    Weekly,
    /// `plan calendar` / `calendar_tasks`.
    Calendar,
    /// `plan stats` / `stats`.
    Stats,
    /// `plan nudges` / `nudges`.
    Nudges,
    /// `plan eat-the-frog` / `motivation_eat_the_frog`.
    EatTheFrog,
    /// `plan task-jar` / `motivation_task_jar`.
    TaskJar,
    /// `plan dopamine` / `motivation_dopamine_menu`.
    Dopamine,
}

const SECRET_KEYS: &[&str] = &[
    "token",
    "access_token",
    "password",
    "secret",
    "authorization",
    "credential",
    "bearer",
];

/// Bound warning lines shown for import preview human output.
const IMPORT_WARNING_LINES: usize = 12;
/// Bound draft lines shown for import preview human output.
const IMPORT_DRAFT_LINES: usize = 20;

/// Emit human text for `value` under `view`.
pub fn emit_human(value: &Value, view: HumanView) -> Result<(), CliError> {
    let text = render_human(value, view)?;
    output::write_human_text(&text)
}

/// Render human text without writing (unit-testable).
pub fn render_human(value: &Value, view: HumanView) -> Result<String, CliError> {
    match view {
        HumanView::PrettyJson => serde_json::to_string_pretty(value)
            .map_err(|error| CliError::runtime("json_encode_failed", error.to_string())),
        HumanView::Projects => Ok(render_named_resource_list(
            value.get("projects").unwrap_or(&Value::Null),
            "projects",
            "project",
        )),
        HumanView::Tags => Ok(render_named_resource_list(
            value.get("tags").unwrap_or(&Value::Null),
            "tags",
            "tag",
        )),
        HumanView::DailyPlan => Ok(render_daily_plan(value)),
        HumanView::EndOfDay => Ok(render_end_of_day(value)),
        HumanView::Weekly => Ok(render_weekly(value)),
        HumanView::Calendar => Ok(render_calendar(value)),
        HumanView::Stats => Ok(render_stats(value)),
        HumanView::Nudges => Ok(render_nudges(value)),
        HumanView::EatTheFrog => Ok(render_eat_the_frog(value)),
        HumanView::TaskJar => Ok(render_task_collection(value, "task-jar")),
        HumanView::Dopamine => Ok(render_task_collection(value, "dopamine")),
        HumanView::Auto => Ok(render_auto(value)),
    }
}

fn render_auto(value: &Value) -> String {
    if value.as_object().is_some_and(serde_json::Map::is_empty) {
        return "ok".to_owned();
    }
    if let Some(text) = try_render_mutation(value) {
        return text;
    }
    if value.get("reminders").is_some() {
        return render_reminders(value);
    }
    // Planning/motivation shapes are wired through explicit HumanView variants
    // from the ergonomic plan handlers. Auto must not infer them: production
    // weekly reviews carry overdue_tasks, empty eat-the-frog omits task, and
    // end-of-day shares no unique key with daily plan under key-overlap checks.
    if value.get("as_of_date").is_some() && value.get("tasks").is_some() {
        return render_task_list(value);
    }
    if value.get("tasks").is_some() && value.get("revision").is_some() {
        return render_task_list(value);
    }
    if value.get("projects").is_some() && value.get("tags").is_some() {
        return render_full_catalog(value);
    }
    if value.get("output_path").is_some() && value.get("bytes_written").is_some() {
        return render_download(value);
    }
    if value.get("content_fingerprint").is_some() && value.get("drafts").is_some() {
        return render_import_preview(value);
    }
    if value.get("hosts").is_some() && value.as_object().is_some_and(|o| o.len() <= 2) {
        return render_hosts(value);
    }
    if value.get("entries").is_some() {
        return render_diagnostics(value);
    }
    if value.get("maintenance_active").is_some() {
        return render_maintenance(value);
    }
    if value.get("mode").is_some() && value.get("restart_required").is_some() {
        return render_recovery(value);
    }
    if value.get("restart_required").is_some()
        && value.as_object().is_some_and(|object| object.len() <= 2)
    {
        return render_restore(value);
    }
    if value.get("token_path").is_some() {
        return format!(
            "token written to {}",
            string_field(value, "token_path").unwrap_or("-")
        );
    }
    if looks_like_task(value) {
        return render_task_detail(value);
    }
    if looks_like_named(value) {
        return render_named_detail(value);
    }
    render_compact_fallback(value)
}

fn try_render_mutation(value: &Value) -> Option<String> {
    let event = value.get("event")?.as_object()?;
    let event_type = event.get("event_type")?.as_str()?;
    let revision = event.get("revision")?;
    let operation_id = event
        .get("operation_id")
        .and_then(Value::as_str)
        .unwrap_or("-");

    let mut parts = vec![event_type.to_owned()];
    if let Some(primary) = event.get("primary") {
        let resource_type = string_field(primary, "resource_type").unwrap_or("resource");
        let id = string_field(primary, "id").unwrap_or("-");
        parts.push(format!("{resource_type}={id}"));
    } else if let Some(id) = snapshot_id(event.get("snapshot")) {
        parts.push(id);
    }
    parts.push(format!("revision={revision}"));
    parts.push(format!("operation={operation_id}"));
    if let Some(outcome) = value.get("uncomplete_outcome") {
        let label = outcome
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| compact_scalar(outcome));
        if !label.is_empty() {
            parts.push(format!("uncomplete_outcome={label}"));
        }
    }
    Some(parts.join("  "))
}

fn snapshot_id(snapshot: Option<&Value>) -> Option<String> {
    let snapshot = snapshot?;
    for key in [
        "task",
        "project",
        "section",
        "tag",
        "template",
        "saved_filter",
        "comment",
        "time_block",
        "time_slot",
    ] {
        if let Some(entity) = snapshot.get(key)
            && let Some(id) = string_field(entity, "id")
        {
            return Some(format!("{key}={id}"));
        }
    }
    None
}

fn render_task_list(value: &Value) -> String {
    let tasks = value.get("tasks").and_then(Value::as_array);
    let Some(tasks) = tasks else {
        return "no tasks".to_owned();
    };
    if tasks.is_empty() {
        return "no tasks".to_owned();
    }
    let mut lines = Vec::with_capacity(tasks.len() + 1);
    let mut header = format!("tasks ({})", tasks.len());
    if let Some(revision) = value.get("revision") {
        header.push_str(&format!("  revision={revision}"));
    }
    if let Some(as_of) = string_field(value, "as_of_date") {
        header.push_str(&format!("  as_of={as_of}"));
    }
    lines.push(header);
    for task in tasks {
        lines.push(task_row(task));
    }
    if let Some(cursor) = string_field(value, "next_cursor") {
        lines.push(format!("next_cursor={cursor}"));
    }
    lines.join("\n")
}

fn render_calendar(value: &Value) -> String {
    let tasks = value.get("tasks").and_then(Value::as_array);
    let Some(tasks) = tasks else {
        return format!(
            "calendar: (none)  revision={}",
            display_field(value, "revision")
        );
    };
    if tasks.is_empty() {
        return format!(
            "calendar: (none)  revision={}",
            display_field(value, "revision")
        );
    }
    let mut lines = vec![format!(
        "calendar tasks ({})  revision={}",
        tasks.len(),
        display_field(value, "revision")
    )];
    for task in tasks {
        lines.push(task_row(task));
    }
    lines.join("\n")
}

fn render_task_detail(task: &Value) -> String {
    let mut lines = vec![format!("task {}", string_field(task, "id").unwrap_or("-"))];
    push_field(&mut lines, "title", string_field(task, "title"));
    push_field(&mut lines, "status", string_field(task, "status"));
    if let Some(priority) = task.get("priority").filter(|value| !value.is_null()) {
        lines.push(format!("priority: {priority}"));
    }
    push_field(&mut lines, "due", string_field(task, "due_date"));
    push_field(&mut lines, "deadline", string_field(task, "deadline"));
    push_field(&mut lines, "project", string_field(task, "project_id"));
    if let Some(tags) = task.get("tag_ids").and_then(Value::as_array)
        && !tags.is_empty()
    {
        let joined = tags
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(",");
        lines.push(format!("tags: {joined}"));
    }
    if let Some(description) = string_field(task, "description").filter(|value| !value.is_empty()) {
        lines.push(format!("description: {description}"));
    }
    if let Some(revision) = task.get("revision") {
        lines.push(format!("revision: {revision}"));
    }
    lines.join("\n")
}

fn render_named_resource_list(list: &Value, plural: &str, singular: &str) -> String {
    let Some(items) = list.as_array() else {
        return format!("no {plural}");
    };
    if items.is_empty() {
        return format!("no {plural}");
    }
    let mut lines = vec![format!("{plural} ({})", items.len())];
    for item in items {
        lines.push(named_row(item, singular));
    }
    lines.join("\n")
}

fn render_full_catalog(value: &Value) -> String {
    let mut lines = Vec::new();
    lines.push(render_named_resource_list(
        value.get("projects").unwrap_or(&Value::Null),
        "projects",
        "project",
    ));
    lines.push(render_named_resource_list(
        value.get("tags").unwrap_or(&Value::Null),
        "tags",
        "tag",
    ));
    if let Some(revision) = value.get("revision") {
        lines.push(format!("revision={revision}"));
    }
    lines.join("\n")
}

fn render_named_detail(value: &Value) -> String {
    let kind = if value.get("archived").is_some() {
        "project"
    } else {
        "tag"
    };
    let mut lines = vec![format!(
        "{kind} {}",
        string_field(value, "id").unwrap_or("-")
    )];
    push_field(&mut lines, "name", string_field(value, "name"));
    push_field(&mut lines, "color", string_field(value, "color"));
    if let Some(archived) = value.get("archived") {
        lines.push(format!("archived: {archived}"));
    }
    lines.join("\n")
}

fn render_reminders(value: &Value) -> String {
    let Some(reminders) = value.get("reminders").and_then(Value::as_array) else {
        return "no reminders".to_owned();
    };
    if reminders.is_empty() {
        return "no reminders".to_owned();
    }
    let mut lines = vec![format!("reminders ({})", reminders.len())];
    for reminder in reminders {
        let task_id = string_field(reminder, "task_id").unwrap_or("-");
        let remind_at = string_field(reminder, "remind_at").unwrap_or("-");
        let state = string_field(reminder, "state").unwrap_or("-");
        lines.push(format!("{task_id}  {state}  {remind_at}"));
    }
    lines.join("\n")
}

fn render_daily_plan(value: &Value) -> String {
    let mut lines = vec![format!(
        "daily plan {}  estimated={}m  capacity={}m  revision={}",
        string_field(value, "as_of_date").unwrap_or("-"),
        metric_field(value, "estimated_total_minutes"),
        metric_field(value, "capacity_minutes"),
        display_field(value, "revision")
    )];
    append_task_section(&mut lines, "focus", value.get("focus_tasks"));
    append_task_section(&mut lines, "overdue", value.get("overdue_tasks"));
    lines.join("\n")
}

fn render_end_of_day(value: &Value) -> String {
    let mut lines = vec![format!(
        "end of day {}  completion={}%  tomorrow={}m  capacity={}m  revision={}",
        string_field(value, "as_of_date").unwrap_or("-"),
        metric_field(value, "completion_rate_percent"),
        metric_field(value, "tomorrow_estimated_minutes"),
        metric_field(value, "capacity_minutes"),
        display_field(value, "revision")
    )];
    append_task_section(&mut lines, "wins", value.get("win_tasks"));
    append_task_section(&mut lines, "carry over", value.get("carry_over_tasks"));
    append_task_section(&mut lines, "tomorrow", value.get("tomorrow_tasks"));
    lines.join("\n")
}

fn render_weekly(value: &Value) -> String {
    let mut lines = vec![format!(
        "weekly review {}..{}  created={} completed={} cancelled={} rate={}% streak={}d revision={}",
        string_field(value, "week_start").unwrap_or("-"),
        string_field(value, "week_end").unwrap_or("-"),
        metric_field(value, "created_count"),
        metric_field(value, "completed_count"),
        metric_field(value, "cancelled_count"),
        metric_field(value, "completion_rate_percent"),
        metric_field(value, "streak_days"),
        display_field(value, "revision")
    )];
    append_task_section(
        &mut lines,
        "top accomplishments",
        value.get("top_accomplishment_tasks"),
    );
    append_task_section(&mut lines, "overdue", value.get("overdue_tasks"));
    if let Some(suggestions) = value.get("suggestions").and_then(Value::as_array) {
        if suggestions.is_empty() {
            lines.push("suggestions: (none)".to_owned());
        } else {
            lines.push(format!("suggestions ({}):", suggestions.len()));
            for suggestion in suggestions.iter().take(8) {
                lines.push(format!("  {}", compact_scalar(suggestion)));
            }
            if suggestions.len() > 8 {
                lines.push(format!("  … {} more suggestions", suggestions.len() - 8));
            }
        }
    }
    lines.join("\n")
}

fn render_stats(value: &Value) -> String {
    format!(
        "stats {}..{}  completions={} creations={} minutes={} streak={}d revision={}",
        string_field(value, "from").unwrap_or("-"),
        string_field(value, "to").unwrap_or("-"),
        metric_field(value, "total_completions"),
        metric_field(value, "total_creations"),
        metric_field(value, "total_completion_minutes"),
        metric_field(value, "current_streak_days"),
        display_field(value, "revision")
    )
}

fn render_nudges(value: &Value) -> String {
    let mut lines = vec![format!(
        "nudges  revision={}",
        display_field(value, "revision")
    )];
    if let Some(rules) = value.get("rules").and_then(Value::as_array) {
        if rules.is_empty() {
            lines.push("rules: (none)".to_owned());
        } else {
            for rule in rules {
                let kind = string_field(rule, "kind").unwrap_or("rule");
                let count = rule
                    .get("task_ids")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0);
                let more = rule
                    .get("has_more")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let suffix = if more { "+" } else { "" };
                lines.push(format!("  {kind}: {count}{suffix}"));
            }
        }
    } else {
        lines.push("rules: (none)".to_owned());
    }
    append_task_section(&mut lines, "tasks", value.get("tasks"));
    lines.join("\n")
}

fn render_eat_the_frog(value: &Value) -> String {
    match value.get("task") {
        Some(task) if !task.is_null() && looks_like_task(task) => {
            let mut lines = vec!["eat-the-frog:".to_owned()];
            lines.push(format!("  {}", task_row(task)));
            lines.push(format!("revision={}", display_field(value, "revision")));
            lines.join("\n")
        }
        _ => format!(
            "eat-the-frog: (none)  revision={}",
            display_field(value, "revision")
        ),
    }
}

fn render_task_collection(value: &Value, label: &str) -> String {
    let mut lines = vec![format!(
        "{label}  revision={}",
        display_field(value, "revision")
    )];
    append_task_section(&mut lines, label, value.get("tasks"));
    lines.join("\n")
}

fn render_download(value: &Value) -> String {
    format!(
        "wrote {} ({} bytes)",
        string_field(value, "output_path").unwrap_or("-"),
        metric_field(value, "bytes_written")
    )
}

fn render_restore(value: &Value) -> String {
    let restart = value
        .get("restart_required")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if restart {
        "restore complete; restart required before normal traffic".to_owned()
    } else {
        "restore complete".to_owned()
    }
}

fn render_import_preview(value: &Value) -> String {
    let drafts = value
        .get("drafts")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let warning_list = value
        .get("warnings")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let warnings = warning_list.len();
    let mut lines = vec![format!(
        "import preview format={} drafts={drafts} warnings={warnings} fingerprint={}",
        string_field(value, "format").unwrap_or("-"),
        string_field(value, "content_fingerprint").unwrap_or("-")
    )];
    if let Some(draft_list) = value.get("drafts").and_then(Value::as_array) {
        for draft in draft_list.iter().take(IMPORT_DRAFT_LINES) {
            let line = draft.get("line").and_then(Value::as_u64).unwrap_or(0);
            let title = string_field(draft, "title").unwrap_or("-");
            lines.push(format!("  L{line} {title}"));
        }
        if draft_list.len() > IMPORT_DRAFT_LINES {
            lines.push(format!(
                "  … {} more drafts",
                draft_list.len() - IMPORT_DRAFT_LINES
            ));
        }
    }
    if !warning_list.is_empty() {
        lines.push(format!("warnings ({warnings}):"));
        for warning in warning_list.iter().take(IMPORT_WARNING_LINES) {
            let line = warning.get("line").and_then(Value::as_u64).unwrap_or(0);
            let message = sanitize_warning_message(string_field(warning, "message").unwrap_or(""));
            lines.push(format!("  L{line} {message}"));
        }
        if warning_list.len() > IMPORT_WARNING_LINES {
            lines.push(format!(
                "  … {} more warnings; re-run with --json for the full list",
                warning_list.len() - IMPORT_WARNING_LINES
            ));
        }
    }
    lines.join("\n")
}

/// Fail-closed human rendering for transfer parser warnings.
///
/// Import warnings may interpolate attacker-controlled labels, field names,
/// dates, and other payload fragments. Human stdout must preserve the material
/// category of each known warning while never echoing those values, secrets, or
/// injected control characters / physical line breaks. Unknown shapes collapse
/// to a fixed redacted marker — never raw text.
fn sanitize_warning_message(message: &str) -> String {
    let normalized = normalize_warning_text(message);
    if normalized.is_empty() {
        return "-".to_owned();
    }
    match classify_transfer_warning(&normalized) {
        Some(safe) => safe.to_owned(),
        None => "(warning redacted)".to_owned(),
    }
}

/// Strip/collapse control characters and Unicode line separators so a warning
/// can never inject additional physical stdout lines.
fn normalize_warning_text(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut pending_space = false;
    for ch in message.chars() {
        let is_unsafe = ch.is_control()
            || ch.is_whitespace()
            || ch == '\u{2028}'
            || ch == '\u{2029}'
            || ch == '\u{0085}';
        if is_unsafe {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    out
}

/// Map a normalized warning onto fixed safe guidance for known categories.
fn classify_transfer_warning(message: &str) -> Option<&'static str> {
    // Exact static parser guidance — preserve wording (no interpolated values).
    const EXACT: &[(&str, &str)] = &[
        (
            "skipped row with empty title",
            "skipped row with empty title",
        ),
        (
            "checked checkbox imported as a pending task (completion is not transferred)",
            "checked checkbox imported as a pending task (completion is not transferred)",
        ),
        ("skipped non-object item", "skipped non-object item"),
        (
            "skipped item without content",
            "skipped item without content",
        ),
        (
            "ignored non-integer priority",
            "ignored non-integer priority",
        ),
        (
            "ignored non-numeric priority",
            "ignored non-numeric priority",
        ),
        ("ignored non-string due_date", "ignored non-string due_date"),
    ];
    for (exact, safe) in EXACT {
        if message == *exact {
            return Some(*safe);
        }
    }

    // Interpolated categories: keep meaning, drop every user-derived fragment.
    // More-specific prefixes are checked before shorter shared prefixes.
    if message.starts_with("unrecognized transfer format label") {
        return Some("unrecognized transfer format label (details redacted)");
    }
    if message.starts_with("unsupported transfer version") {
        return Some("unsupported transfer version treated as best-effort (details redacted)");
    }
    if message.starts_with("ignored unknown root field") {
        return Some("ignored unknown root field (name redacted)");
    }
    if message.starts_with("ignored unknown item field") {
        return Some("ignored unknown item field (name redacted)");
    }
    if message.starts_with("ignored unknown field") {
        return Some("ignored unknown field (name redacted)");
    }
    if message.starts_with("ignored out-of-range Todoist priority") {
        return Some("ignored out-of-range Todoist priority (value redacted)");
    }
    if message.starts_with("ignored invalid due date") {
        return Some("ignored invalid due date (details redacted)");
    }
    if message.starts_with("ignored invalid due_date") {
        return Some("ignored invalid due_date (details redacted)");
    }
    if message.starts_with("ignored out-of-range priority") {
        return Some("ignored out-of-range priority (value redacted)");
    }
    if message.starts_with("ignored non-numeric priority") {
        return Some("ignored non-numeric priority (value redacted)");
    }
    if message.starts_with("ignored non-object entry in") && message.ends_with("catalog") {
        return Some("ignored non-object entry in catalog (name redacted)");
    }

    None
}

fn render_hosts(value: &Value) -> String {
    let Some(hosts) = value.get("hosts").and_then(Value::as_array) else {
        return "no hosts".to_owned();
    };
    if hosts.is_empty() {
        return "no hosts".to_owned();
    }
    let mut lines = vec![format!("hosts ({})", hosts.len())];
    for host in hosts {
        lines.push(host.as_str().unwrap_or("-").to_owned());
    }
    lines.join("\n")
}

fn render_diagnostics(value: &Value) -> String {
    let Some(entries) = value.get("entries").and_then(Value::as_array) else {
        return "no diagnostics".to_owned();
    };
    if entries.is_empty() {
        return "no diagnostics".to_owned();
    }
    let mut lines = vec![format!("diagnostics ({})", entries.len())];
    for entry in entries.iter().take(50) {
        let ts = string_field(entry, "timestamp").unwrap_or("-");
        let severity = entry
            .get("severity")
            .map(compact_scalar)
            .unwrap_or_else(|| "-".to_owned());
        let code = string_field(entry, "code").unwrap_or("-");
        let message = string_field(entry, "message").unwrap_or("");
        lines.push(format!("{ts}  {severity}  {code}  {message}"));
    }
    if entries.len() > 50 {
        lines.push(format!("… {} more entries", entries.len() - 50));
    }
    lines.join("\n")
}

fn render_maintenance(value: &Value) -> String {
    format!(
        "maintenance_active={}  restart_required={}  recovery_mode={}  admitted_requests={}",
        bool_field(value, "maintenance_active"),
        bool_field(value, "restart_required"),
        bool_field(value, "recovery_mode"),
        metric_field(value, "admitted_requests")
    )
}

fn render_recovery(value: &Value) -> String {
    format!(
        "recovery mode={}  restart_required={}",
        string_field(value, "mode").unwrap_or("-"),
        bool_field(value, "restart_required")
    )
}

fn render_compact_fallback(value: &Value) -> String {
    match value {
        Value::Null => "ok".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            if items.is_empty() {
                return "(empty)".to_owned();
            }
            if items.iter().all(is_scalar) {
                return items
                    .iter()
                    .take(32)
                    .map(compact_scalar)
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            format!("({} items)", items.len())
        }
        Value::Object(object) => {
            if object.is_empty() {
                return "ok".to_owned();
            }
            let mut lines = Vec::new();
            for (key, child) in object {
                if is_secret_key(key) {
                    lines.push(format!("{key}: (redacted)"));
                    continue;
                }
                if is_scalar(child) {
                    lines.push(format!("{key}: {}", compact_scalar(child)));
                    continue;
                }
                if let Some(array) = child.as_array() {
                    if array.iter().all(is_scalar) && array.len() <= 16 {
                        let joined = array
                            .iter()
                            .map(compact_scalar)
                            .collect::<Vec<_>>()
                            .join(",");
                        lines.push(format!("{key}: [{joined}]"));
                    } else {
                        lines.push(format!("{key}: ({} items)", array.len()));
                    }
                    continue;
                }
                if let Some(nested) = child.as_object() {
                    let scalars = nested
                        .iter()
                        .filter(|(nested_key, nested_value)| {
                            !is_secret_key(nested_key) && is_scalar(nested_value)
                        })
                        .take(8)
                        .map(|(nested_key, nested_value)| {
                            format!("{nested_key}={}", compact_scalar(nested_value))
                        })
                        .collect::<Vec<_>>();
                    if !scalars.is_empty() {
                        lines.push(format!("{key}: {}", scalars.join(" ")));
                    } else {
                        lines.push(format!("{key}: (object)"));
                    }
                    continue;
                }
                lines.push(format!("{key}: (value)"));
            }
            if lines.is_empty() {
                "ok".to_owned()
            } else {
                lines.join("\n")
            }
        }
    }
}

fn append_task_section(lines: &mut Vec<String>, label: &str, tasks: Option<&Value>) {
    let Some(tasks) = tasks.and_then(Value::as_array) else {
        lines.push(format!("{label}: (none)"));
        return;
    };
    if tasks.is_empty() {
        lines.push(format!("{label}: (none)"));
        return;
    }
    lines.push(format!("{label} ({}):", tasks.len()));
    for task in tasks {
        lines.push(format!("  {}", task_row(task)));
    }
}

fn task_row(task: &Value) -> String {
    let id = string_field(task, "id").unwrap_or("-");
    let status = string_field(task, "status").unwrap_or("-");
    let priority = task
        .get("priority")
        .filter(|value| !value.is_null())
        .map(|value| format!("p{}", compact_scalar(value)))
        .unwrap_or_else(|| "-".to_owned());
    let due = string_field(task, "due_date").unwrap_or("-");
    let title = string_field(task, "title").unwrap_or("-");
    format!("{id}  {status}  {priority}  {due}  {title}")
}

fn named_row(item: &Value, singular: &str) -> String {
    let id = string_field(item, "id").unwrap_or("-");
    let name = string_field(item, "name").unwrap_or("-");
    let color = string_field(item, "color").unwrap_or("-");
    if let Some(archived) = item.get("archived").and_then(Value::as_bool) {
        let state = if archived { "archived" } else { "active" };
        format!("{id}  {color}  {state}  {name}")
    } else {
        let _ = singular;
        format!("{id}  {color}  {name}")
    }
}

fn looks_like_task(value: &Value) -> bool {
    value.get("id").is_some()
        && value.get("title").is_some()
        && value.get("status").is_some()
        && value.get("event").is_none()
}

fn looks_like_named(value: &Value) -> bool {
    value.get("id").is_some()
        && value.get("name").is_some()
        && value.get("color").is_some()
        && value.get("event").is_none()
        && value.get("tasks").is_none()
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Present metric values only; never invent a zero for a missing field.
fn metric_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .filter(|child| !child.is_null())
        .map(compact_scalar)
        .unwrap_or_else(|| "-".to_owned())
}

fn display_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(compact_scalar)
        .unwrap_or_else(|| "-".to_owned())
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn push_field(lines: &mut Vec<String>, label: &str, value: Option<&str>) {
    if let Some(value) = value {
        lines.push(format!("{label}: {value}"));
    }
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn compact_scalar(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => format!("[{} items]", items.len()),
        Value::Object(object) => {
            if let Some(kind) = object.get("kind").and_then(Value::as_str) {
                let mut parts = vec![kind.to_owned()];
                for (key, child) in object {
                    if key == "kind" || is_secret_key(key) || !is_scalar(child) {
                        continue;
                    }
                    parts.push(format!("{key}={}", compact_scalar(child)));
                }
                parts.join(" ")
            } else {
                format!("({{{} keys}})", object.len())
            }
        }
    }
}

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_KEYS
        .iter()
        .any(|secret| lower == *secret || lower.ends_with(&format!("_{secret}")))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{HumanView, render_human, sanitize_warning_message};

    #[test]
    fn mutation_is_one_compact_line_with_ids() {
        let value = json!({
            "event": {
                "revision": 4,
                "operation_id": "11111111-1111-1111-1111-111111111111",
                "event_type": "project.created",
                "primary": {
                    "resource_type": "project",
                    "id": "22222222-2222-2222-2222-222222222222"
                },
                "snapshot": {
                    "resource_type": "project",
                    "project": {
                        "id": "22222222-2222-2222-2222-222222222222",
                        "name": "Huge",
                        "color": "#3b82f6",
                        "description": "x".repeat(4000)
                    }
                }
            }
        });
        let text = render_human(&value, HumanView::Auto).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(!text.trim_start().starts_with('{'));
        assert!(!text.contains("Huge"));
        assert!(!text.contains("snapshot"));
        assert!(text.contains("project.created"));
        assert!(text.contains("project=22222222-2222-2222-2222-222222222222"));
        assert!(text.contains("revision=4"));
        assert!(text.contains("operation=11111111-1111-1111-1111-111111111111"));
        assert!(text.len() < 240);
    }

    #[test]
    fn task_list_and_detail_stay_tabular() {
        let list = json!({
            "tasks": [{
                "id": "33333333-3333-3333-3333-333333333333",
                "title": "Ship",
                "status": "pending",
                "priority": 2,
                "due_date": "2030-01-15"
            }],
            "revision": 9,
            "as_of_date": "2030-01-10"
        });
        let text = render_human(&list, HumanView::Auto).unwrap();
        assert!(text.contains("tasks (1)"));
        assert!(text.contains("33333333-3333-3333-3333-333333333333"));
        assert!(text.contains("pending"));
        assert!(text.contains("Ship"));
        assert!(!text.trim_start().starts_with('{'));

        let empty = json!({"tasks": [], "revision": 1, "as_of_date": "2030-01-10"});
        assert_eq!(render_human(&empty, HumanView::Auto).unwrap(), "no tasks");

        let detail = json!({
            "id": "33333333-3333-3333-3333-333333333333",
            "title": "Ship",
            "status": "pending",
            "priority": 2,
            "due_date": "2030-01-15",
            "revision": 9
        });
        let detail_text = render_human(&detail, HumanView::Auto).unwrap();
        assert!(detail_text.starts_with("task 33333333-3333-3333-3333-333333333333"));
        assert!(detail_text.contains("title: Ship"));
        assert!(!detail_text.contains("\"status\""));
    }

    #[test]
    fn project_and_tag_views_hide_unrelated_catalog_sections() {
        let catalog = json!({
            "projects": [{
                "id": "44444444-4444-4444-4444-444444444444",
                "name": "Rewrite",
                "color": "#3b82f6",
                "archived": false
            }],
            "sections": [{"id": "sec", "name": "Inbox"}],
            "tags": [{
                "id": "55555555-5555-5555-5555-555555555555",
                "name": "wave",
                "color": "#111111"
            }],
            "templates": [{"id": "tpl", "name": "T"}],
            "saved_filters": [{"id": "sf", "name": "F"}],
            "revision": 3
        });
        let projects = render_human(&catalog, HumanView::Projects).unwrap();
        assert!(projects.contains("projects (1)"));
        assert!(projects.contains("Rewrite"));
        assert!(!projects.contains("wave"));
        assert!(!projects.contains("templates"));
        assert!(!projects.contains("sections"));

        let tags = render_human(&catalog, HumanView::Tags).unwrap();
        assert!(tags.contains("tags (1)"));
        assert!(tags.contains("wave"));
        assert!(!tags.contains("Rewrite"));
        assert!(!tags.contains("templates"));
    }

    #[test]
    fn reminder_planning_and_data_shapes_are_concise() {
        let reminders = json!({
            "reminders": [{
                "task_id": "33333333-3333-3333-3333-333333333333",
                "remind_at": "2030-01-15T12:00:00Z",
                "state": "pending"
            }]
        });
        let reminder_text = render_human(&reminders, HumanView::Auto).unwrap();
        assert!(reminder_text.contains("reminders (1)"));
        assert!(reminder_text.contains("2030-01-15T12:00:00Z"));
        assert!(!reminder_text.trim_start().starts_with('{'));

        let plan = json!({
            "as_of_date": "2030-01-15",
            "overdue_task_ids": [],
            "overdue_tasks": [],
            "focus_task_ids": ["33333333-3333-3333-3333-333333333333"],
            "focus_tasks": [{
                "id": "33333333-3333-3333-3333-333333333333",
                "title": "Focus",
                "status": "pending",
                "priority": 1,
                "due_date": "2030-01-15"
            }],
            "estimated_total_minutes": 30,
            "capacity_minutes": 480,
            "revision": 2
        });
        let plan_text = render_human(&plan, HumanView::DailyPlan).unwrap();
        assert!(plan_text.contains("daily plan 2030-01-15"));
        assert!(plan_text.contains("focus (1):"));
        assert!(plan_text.contains("Focus"));
        assert!(!plan_text.contains("focus_task_ids"));

        let download = json!({
            "output_path": "/tmp/out.json",
            "bytes_written": 12
        });
        assert_eq!(
            render_human(&download, HumanView::Auto).unwrap(),
            "wrote /tmp/out.json (12 bytes)"
        );

        let restore = json!({ "restart_required": true });
        assert!(
            render_human(&restore, HumanView::Auto)
                .unwrap()
                .contains("restart required")
        );
    }

    #[test]
    fn weekly_review_is_not_misclassified_as_daily_plan() {
        // Production WeeklyReviewResponse always carries overdue_tasks; Auto used
        // to match that key and fabricate a daily plan header.
        let weekly = json!({
            "as_of_date": "2030-01-15",
            "week_start": "2030-01-13",
            "week_end": "2030-01-19",
            "daily": [
                {"date": "2030-01-13", "completed": 1, "created": 2}
            ],
            "created_count": 2,
            "completed_count": 1,
            "cancelled_count": 0,
            "completion_rate_percent": 50,
            "completion_time_buckets": {
                "morning": 1, "afternoon": 0, "evening": 0, "night": 0
            },
            "top_accomplishment_ids": [],
            "top_accomplishment_tasks": [],
            "overdue_task_ids": ["33333333-3333-3333-3333-333333333333"],
            "overdue_tasks": [{
                "id": "33333333-3333-3333-3333-333333333333",
                "title": "Late",
                "status": "pending",
                "priority": 1,
                "due_date": "2030-01-01"
            }],
            "neglected_projects": [],
            "streak_days": 3,
            "suggestions": [{"kind": "tackle_overdue", "count": 1}],
            "revision": 7
        });
        let text = render_human(&weekly, HumanView::Weekly).unwrap();
        assert!(text.starts_with("weekly review 2030-01-13..2030-01-19"));
        assert!(text.contains("created=2"));
        assert!(text.contains("completed=1"));
        assert!(text.contains("rate=50%"));
        assert!(text.contains("streak=3d"));
        assert!(text.contains("overdue (1):"));
        assert!(text.contains("Late"));
        assert!(text.contains("suggestions (1):"));
        assert!(!text.contains("daily plan"));
        assert!(!text.contains("estimated="));
        // Absent metrics must not be invented as zero via Auto fallback.
        let auto = render_human(&weekly, HumanView::Auto).unwrap();
        assert!(!auto.contains("daily plan"));
    }

    #[test]
    fn end_of_day_uses_actual_review_fields() {
        let eod = json!({
            "as_of_date": "2030-01-15",
            "win_task_ids": ["33333333-3333-3333-3333-333333333333"],
            "win_tasks": [{
                "id": "33333333-3333-3333-3333-333333333333",
                "title": "Shipped",
                "status": "completed",
                "priority": 2,
                "due_date": "2030-01-15"
            }],
            "carry_over_task_ids": [],
            "carry_over_tasks": [],
            "tomorrow_task_ids": [],
            "tomorrow_tasks": [],
            "tomorrow_estimated_minutes": 0,
            "completion_rate_percent": 100,
            "capacity_minutes": 480,
            "revision": 4
        });
        let text = render_human(&eod, HumanView::EndOfDay).unwrap();
        assert!(text.starts_with("end of day 2030-01-15"));
        assert!(text.contains("completion=100%"));
        assert!(text.contains("wins (1):"));
        assert!(text.contains("Shipped"));
        assert!(text.contains("carry over: (none)"));
        assert!(text.contains("tomorrow: (none)"));
        assert!(!text.contains("daily plan"));
        assert!(!text.contains("focus"));
    }

    #[test]
    fn empty_eat_the_frog_reports_none_without_inventing_a_task() {
        // Production omits `task` when none is selected (skip_serializing_if).
        let empty = json!({ "revision": 5 });
        let text = render_human(&empty, HumanView::EatTheFrog).unwrap();
        assert_eq!(text, "eat-the-frog: (none)  revision=5");
        assert!(!text.contains("daily plan"));

        let null_task = json!({ "task": null, "revision": 5 });
        assert_eq!(
            render_human(&null_task, HumanView::EatTheFrog).unwrap(),
            "eat-the-frog: (none)  revision=5"
        );

        let selected = json!({
            "task": {
                "id": "33333333-3333-3333-3333-333333333333",
                "title": "Hardest",
                "status": "pending",
                "priority": 1,
                "due_date": "2030-01-15"
            },
            "revision": 6
        });
        let selected_text = render_human(&selected, HumanView::EatTheFrog).unwrap();
        assert!(selected_text.starts_with("eat-the-frog:"));
        assert!(selected_text.contains("Hardest"));
        assert!(selected_text.contains("revision=6"));
    }

    #[test]
    fn planning_metrics_do_not_invent_absent_zeros() {
        let sparse = json!({
            "as_of_date": "2030-01-15",
            "focus_tasks": [],
            "overdue_tasks": [],
            "revision": 1
        });
        let text = render_human(&sparse, HumanView::DailyPlan).unwrap();
        assert!(text.contains("estimated=-m"));
        assert!(text.contains("capacity=-m"));
        assert!(!text.contains("estimated=0m"));
        assert!(!text.contains("capacity=0m"));
    }

    #[test]
    fn import_preview_shows_warning_line_and_message() {
        let preview = json!({
            "format": "markdown",
            "drafts": [{
                "title": "Done already",
                "tag_names": [],
                "line": 1
            }],
            "project_names": [],
            "tag_names": [],
            "warnings": [{
                "line": 1,
                "message": "checked checkbox imported as a pending task (completion is not transferred)"
            }],
            "content_fingerprint": "abc123"
        });
        let text = render_human(&preview, HumanView::Auto).unwrap();
        assert!(text.contains("import preview format=markdown"));
        assert!(text.contains("warnings=1"));
        assert!(text.contains("warnings (1):"));
        assert!(text.contains(
            "L1 checked checkbox imported as a pending task (completion is not transferred)"
        ));
        assert!(text.contains("L1 Done already"));
        assert!(!text.trim_start().starts_with('{'));
    }

    #[test]
    fn import_preview_truncates_warnings_with_json_guidance() {
        let warnings: Vec<_> = (1..=15)
            .map(|line| {
                json!({
                    "line": line,
                    "message": format!("warning number {line}")
                })
            })
            .collect();
        let preview = json!({
            "format": "markdown",
            "drafts": [],
            "project_names": [],
            "tag_names": [],
            "warnings": warnings,
            "content_fingerprint": "fp"
        });
        let text = render_human(&preview, HumanView::Auto).unwrap();
        assert!(text.contains("warnings=15"));
        assert!(text.contains("warnings (15):"));
        // Unknown shapes are fail-closed redacted, never raw interpolated text.
        assert!(text.contains("L1 (warning redacted)"));
        assert!(text.contains("L12 (warning redacted)"));
        assert!(!text.contains("L13 (warning redacted)"));
        assert!(!text.contains("warning number"));
        assert!(text.contains("… 3 more warnings; re-run with --json for the full list"));
    }

    #[test]
    fn sanitize_warning_message_covers_every_known_category_and_unknown() {
        // Exact static guidance preserved.
        assert_eq!(
            sanitize_warning_message(
                "checked checkbox imported as a pending task (completion is not transferred)"
            ),
            "checked checkbox imported as a pending task (completion is not transferred)"
        );
        assert_eq!(
            sanitize_warning_message("skipped row with empty title"),
            "skipped row with empty title"
        );
        assert_eq!(
            sanitize_warning_message("skipped non-object item"),
            "skipped non-object item"
        );
        assert_eq!(
            sanitize_warning_message("skipped item without content"),
            "skipped item without content"
        );
        assert_eq!(
            sanitize_warning_message("ignored non-integer priority"),
            "ignored non-integer priority"
        );
        assert_eq!(
            sanitize_warning_message("ignored non-numeric priority"),
            "ignored non-numeric priority"
        );
        assert_eq!(
            sanitize_warning_message("ignored non-string due_date"),
            "ignored non-string due_date"
        );

        // Interpolated categories redact user-derived fragments.
        assert_eq!(
            sanitize_warning_message("unrecognized transfer format label `evil-token-value`"),
            "unrecognized transfer format label (details redacted)"
        );
        assert_eq!(
            sanitize_warning_message("unsupported transfer version `99` treated as best-effort"),
            "unsupported transfer version treated as best-effort (details redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored unknown field `secret_key`"),
            "ignored unknown field (name redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored unknown root field `webhook`"),
            "ignored unknown root field (name redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored unknown item field `password`"),
            "ignored unknown item field (name redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored out-of-range Todoist priority 9"),
            "ignored out-of-range Todoist priority (value redacted)"
        );
        assert_eq!(
            sanitize_warning_message(
                "ignored invalid due date: expected YYYY-MM-DD, got `not-a-date`"
            ),
            "ignored invalid due date (details redacted)"
        );
        assert_eq!(
            sanitize_warning_message(
                "ignored invalid due_date: expected YYYY-MM-DD, got `2024-13-40`"
            ),
            "ignored invalid due_date (details redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored out-of-range priority 99"),
            "ignored out-of-range priority (value redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored out-of-range priority `P9`"),
            "ignored out-of-range priority (value redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored non-numeric priority `high`"),
            "ignored non-numeric priority (value redacted)"
        );
        assert_eq!(
            sanitize_warning_message("ignored non-object entry in name catalog"),
            "ignored non-object entry in catalog (name redacted)"
        );

        // Control / newline injection cannot survive into human output.
        let injected = sanitize_warning_message(
            "unrecognized transfer format label `abc\ninjected-line\r\nmore`",
        );
        assert_eq!(
            injected,
            "unrecognized transfer format label (details redacted)"
        );
        assert!(!injected.contains('\n'));
        assert!(!injected.contains('\r'));
        assert!(!injected.contains("injected-line"));

        // Unknown future shapes never render raw text.
        assert_eq!(
            sanitize_warning_message("brand new parser warning with secret-looking payload"),
            "(warning redacted)"
        );
        assert_eq!(sanitize_warning_message(""), "-");
        assert_eq!(sanitize_warning_message("\n\t  "), "-");
    }

    #[test]
    fn import_preview_redacts_format_label_and_blocks_line_injection() {
        let tokenish = "a".repeat(64);
        let preview = json!({
            "format": "json",
            "drafts": [{
                "title": "T",
                "tag_names": [],
                "line": 1
            }],
            "project_names": [],
            "tag_names": [],
            "warnings": [{
                "line": 0,
                "message": format!(
                    "unrecognized transfer format label `{tokenish}\nINJECTED SECRET LINE`"
                )
            }],
            "content_fingerprint": "fp"
        });
        let text = render_human(&preview, HumanView::Auto).unwrap();
        assert!(text.contains("unrecognized transfer format label (details redacted)"));
        assert!(!text.contains(&tokenish));
        assert!(!text.contains("INJECTED SECRET LINE"));
        let warning_rows: Vec<_> = text
            .lines()
            .filter(|line| line.starts_with("  L") && line.contains("redacted"))
            .collect();
        assert_eq!(warning_rows.len(), 1, "expected one physical warning row");
        assert!(!text.contains("\nINJECTED"));
    }

    #[test]
    fn pretty_json_view_preserves_machine_oriented_output() {
        let value = json!({"event":{"revision":1},"nested":{"a":1}});
        let text = render_human(&value, HumanView::PrettyJson).unwrap();
        assert!(text.trim_start().starts_with('{'));
        assert!(text.contains("\"revision\": 1"));
    }

    #[test]
    fn fallback_never_prints_tokens_or_giant_nested_json() {
        let value = json!({
            "token": "super-secret-token-value",
            "access_token": "another-secret",
            "path": "/tmp/x",
            "blob": {"nested": {"deep": {"value": "x".repeat(5000)}}},
            "items": [{"a":1},{"b":2},{"c":3}]
        });
        let text = render_human(&value, HumanView::Auto).unwrap();
        assert!(!text.contains("super-secret-token-value"));
        assert!(!text.contains("another-secret"));
        assert!(text.contains("token: (redacted)"));
        assert!(text.contains("blob: (object)"));
        assert!(text.contains("items: (3 items)"));
        assert!(!text.trim_start().starts_with('{'));
        assert!(text.len() < 400);
    }
}
