//! MCP prompts that assemble instructions plus live read-tool context.

use junban_cli::catalog::wrappers::validate_civil_date as validate_catalog_civil_date;
use junban_cli::{CliError, PrincipalCapabilities, Session};
use rmcp::model::{Prompt, PromptArgument, PromptMessage, Role};
use serde_json::{Map, Value, json};

const MAX_CAPACITY: u32 = 24 * 60;
const MAX_LIMIT: u32 = 100;
const DEFAULT_LIMIT: u32 = 25;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    PlanMyDay,
    TriageInbox,
    WeeklyReview,
}

impl PromptKind {
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::PlanMyDay => "plan-my-day",
            Self::TriageInbox => "triage-inbox",
            Self::WeeklyReview => "weekly-review",
        }
    }

    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "plan-my-day" => Some(Self::PlanMyDay),
            "triage-inbox" => Some(Self::TriageInbox),
            "weekly-review" => Some(Self::WeeklyReview),
            _ => None,
        }
    }

    /// All prompts are read-only context assemblers; none require write.
    #[must_use]
    pub fn is_authorized(self, capabilities: &PrincipalCapabilities) -> bool {
        capabilities.has_read()
    }

    #[must_use]
    pub fn description(self) -> &'static str {
        match self {
            Self::PlanMyDay => {
                "Bounded plan for the selected day using planning context and due tasks. Read-only."
            }
            Self::TriageInbox => {
                "Triage the inbox with suggested next actions. Read-only; does not mutate data."
            }
            Self::WeeklyReview => "Weekly review using planning/stats context. Read-only.",
        }
    }
}

pub fn list_prompt_defs(capabilities: &PrincipalCapabilities) -> Vec<Prompt> {
    [
        PromptKind::PlanMyDay,
        PromptKind::TriageInbox,
        PromptKind::WeeklyReview,
    ]
    .into_iter()
    .filter(|kind| kind.is_authorized(capabilities))
    .map(|kind| {
        Prompt::new(
            kind.name(),
            Some(kind.description()),
            Some(prompt_arguments(kind)),
        )
    })
    .collect()
}

fn prompt_arguments(kind: PromptKind) -> Vec<PromptArgument> {
    match kind {
        PromptKind::PlanMyDay => vec![
            PromptArgument::new("date")
                .with_description("Optional civil date YYYY-MM-DD")
                .with_required(false),
            PromptArgument::new("capacity")
                .with_description("Optional daily capacity in minutes (1..=1440)")
                .with_required(false),
        ],
        PromptKind::TriageInbox => vec![
            PromptArgument::new("limit")
                .with_description("Optional inbox item limit (1..=100)")
                .with_required(false),
        ],
        PromptKind::WeeklyReview => vec![
            PromptArgument::new("date")
                .with_description("Optional civil date YYYY-MM-DD anchoring the week")
                .with_required(false),
        ],
    }
}

#[derive(Debug, Clone)]
pub struct PromptArgs {
    pub date: Option<String>,
    pub capacity: Option<u32>,
    pub limit: Option<u32>,
}

pub fn parse_prompt_arguments(
    kind: PromptKind,
    arguments: Option<&Map<String, Value>>,
) -> Result<PromptArgs, CliError> {
    let empty = Map::new();
    let arguments = arguments.unwrap_or(&empty);

    let allowed: &[&str] = match kind {
        PromptKind::PlanMyDay => &["date", "capacity"],
        PromptKind::TriageInbox => &["limit"],
        PromptKind::WeeklyReview => &["date"],
    };
    for key in arguments.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(CliError::usage(
                "unknown_prompt_argument",
                format!("unknown prompt argument '{key}'"),
            ));
        }
    }

    let date = match arguments.get("date") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            validate_prompt_civil_date(raw)?;
            Some(raw.clone())
        }
        Some(_) => {
            return Err(CliError::usage(
                "invalid_prompt_argument",
                "date must be a string",
            ));
        }
    };
    let capacity = match arguments.get("capacity") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_bounded_number(value, "capacity", 1, MAX_CAPACITY)?),
    };
    let limit = match arguments.get("limit") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_bounded_number(value, "limit", 1, MAX_LIMIT)?),
    };

    Ok(PromptArgs {
        date,
        capacity,
        limit,
    })
}

fn validate_prompt_civil_date(raw: &str) -> Result<(), CliError> {
    // Reuse catalog/jiff civil-date parsing so impossible dates (e.g. 2030-02-31) reject.
    validate_catalog_civil_date(raw, "date").map_err(|_| {
        CliError::usage(
            "invalid_prompt_argument",
            "date must be a valid civil date in YYYY-MM-DD form",
        )
    })
}

fn parse_bounded_number(value: &Value, field: &str, min: u32, max: u32) -> Result<u32, CliError> {
    let number = match value {
        Value::Number(number) => number
            .as_u64()
            .ok_or_else(|| {
                CliError::usage(
                    "invalid_prompt_argument",
                    format!("{field} must be an integer"),
                )
            })?
            .try_into()
            .map_err(|_| {
                CliError::usage(
                    "invalid_prompt_argument",
                    format!("{field} must be between {min} and {max}"),
                )
            })?,
        Value::String(raw) => raw.parse::<u32>().map_err(|_| {
            CliError::usage(
                "invalid_prompt_argument",
                format!("{field} must be an integer"),
            )
        })?,
        _ => {
            return Err(CliError::usage(
                "invalid_prompt_argument",
                format!("{field} must be an integer"),
            ));
        }
    };
    if number < min || number > max {
        return Err(CliError::usage(
            "invalid_prompt_argument",
            format!("{field} must be between {min} and {max}"),
        ));
    }
    Ok(number)
}

/// Build the list_tasks query for plan-my-day (unit-tested).
#[must_use]
pub fn plan_my_day_task_query(date: Option<&str>) -> Value {
    match date {
        Some(date) => json!({ "due_on": date }),
        None => json!({ "view": "today" }),
    }
}

/// Extract stats `from`/`to` from a planning_weekly response (unit-tested).
pub fn stats_range_from_weekly(weekly: &Value) -> Result<(String, String), CliError> {
    let week_start = weekly
        .get("week_start")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CliError::runtime(
                "prompt_context_invalid",
                "planning_weekly response missing week_start",
            )
        })?;
    let week_end = weekly
        .get("week_end")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CliError::runtime(
                "prompt_context_invalid",
                "planning_weekly response missing week_end",
            )
        })?;
    validate_prompt_civil_date(week_start)?;
    validate_prompt_civil_date(week_end)?;
    Ok((week_start.to_owned(), week_end.to_owned()))
}

pub async fn build_prompt(
    session: &mut Session,
    kind: PromptKind,
    args: PromptArgs,
) -> Result<Vec<PromptMessage>, CliError> {
    let context = match kind {
        PromptKind::PlanMyDay => {
            let mut daily_input = Map::new();
            if let Some(date) = &args.date {
                daily_input.insert("date".into(), json!(date));
            }
            if let Some(capacity) = args.capacity {
                daily_input.insert("capacity_minutes".into(), json!(capacity));
            }
            let daily = session
                .call_tool("planning_daily", Value::Object(daily_input))
                .await?
                .value;
            let task_query = plan_my_day_task_query(args.date.as_deref());
            let day_tasks = session.call_tool("list_tasks", task_query).await?.value;
            json!({
                "date": args.date,
                "capacity_minutes": args.capacity,
                "planning_daily": daily,
                "day_tasks": day_tasks,
            })
        }
        PromptKind::TriageInbox => {
            let limit = args.limit.unwrap_or(DEFAULT_LIMIT);
            let inbox = session
                .call_tool(
                    "list_tasks",
                    json!({
                        "view": "inbox",
                        "limit": limit,
                    }),
                )
                .await?
                .value;
            json!({
                "limit": limit,
                "inbox_tasks": inbox,
            })
        }
        PromptKind::WeeklyReview => {
            let mut weekly_input = Map::new();
            if let Some(date) = &args.date {
                weekly_input.insert("date".into(), json!(date));
            }
            let weekly = session
                .call_tool("planning_weekly", Value::Object(weekly_input))
                .await?
                .value;
            let (from, to) = stats_range_from_weekly(&weekly)?;
            let stats = session
                .call_tool("stats", json!({ "from": from, "to": to }))
                .await?
                .value;
            json!({
                "date": args.date,
                "planning_weekly": weekly,
                "stats": stats,
            })
        }
    };

    let instructions = match kind {
        PromptKind::PlanMyDay => {
            "You are helping plan the user's day in Junban. Use the provided JSON context only. \
Do not invent task IDs. Prefer exact IDs from context. This prompt is read-only; propose a plan \
without calling mutation tools unless the user explicitly asks afterward."
        }
        PromptKind::TriageInbox => {
            "You are triaging the Junban inbox. Use the provided JSON context only. \
Suggest concrete next actions with exact task IDs. This prompt does not mutate data; \
apply changes only through authorized write tools after user confirmation when destructive."
        }
        PromptKind::WeeklyReview => {
            "You are facilitating a weekly review in Junban. Use the provided JSON context only. \
Summarize progress, risks, and next-week focus using exact IDs. This prompt is read-only."
        }
    };

    let body = format!(
        "{instructions}\n\nContext JSON:\n{}",
        serde_json::to_string_pretty(&context)
            .map_err(|error| CliError::runtime("prompt_encode_failed", error.to_string()))?
    );
    if body.len() > 2 * 1024 * 1024 {
        return Err(CliError::runtime(
            "prompt_too_large",
            "prompt context exceeds 2 MiB",
        ));
    }

    Ok(vec![PromptMessage::new_text(Role::User, body)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_and_invalid_args() {
        let mut args = Map::new();
        args.insert("nope".into(), json!("1"));
        let err = parse_prompt_arguments(PromptKind::PlanMyDay, Some(&args)).unwrap_err();
        assert_eq!(err.code(), "unknown_prompt_argument");

        let mut bad_date = Map::new();
        bad_date.insert("date".into(), json!("10-01-2030"));
        let err = parse_prompt_arguments(PromptKind::WeeklyReview, Some(&bad_date)).unwrap_err();
        assert_eq!(err.code(), "invalid_prompt_argument");

        let mut impossible = Map::new();
        impossible.insert("date".into(), json!("2030-02-31"));
        let err = parse_prompt_arguments(PromptKind::PlanMyDay, Some(&impossible)).unwrap_err();
        assert_eq!(err.code(), "invalid_prompt_argument");

        let mut bad_limit = Map::new();
        bad_limit.insert("limit".into(), json!(0));
        let err = parse_prompt_arguments(PromptKind::TriageInbox, Some(&bad_limit)).unwrap_err();
        assert_eq!(err.code(), "invalid_prompt_argument");
    }

    #[test]
    fn all_prompts_require_only_read() {
        let read_only = PrincipalCapabilities {
            kind: junban_server::PrincipalKindDto::Automation,
            scopes: vec![junban_server::AutomationScope::Read],
        };
        assert!(PromptKind::PlanMyDay.is_authorized(&read_only));
        assert!(PromptKind::TriageInbox.is_authorized(&read_only));
        assert!(PromptKind::WeeklyReview.is_authorized(&read_only));

        let write_only = PrincipalCapabilities {
            kind: junban_server::PrincipalKindDto::Automation,
            scopes: vec![junban_server::AutomationScope::Write],
        };
        assert!(!PromptKind::TriageInbox.is_authorized(&write_only));
        assert!(!PromptKind::PlanMyDay.is_authorized(&write_only));
    }

    #[test]
    fn plan_my_day_query_uses_selected_due_on_or_today_view() {
        assert_eq!(
            plan_my_day_task_query(Some("2030-01-15")),
            json!({ "due_on": "2030-01-15" })
        );
        assert_eq!(plan_my_day_task_query(None), json!({ "view": "today" }));
    }

    #[test]
    fn weekly_stats_range_uses_planning_week_bounds() {
        let weekly = json!({
            "week_start": "2030-01-13",
            "week_end": "2030-01-19",
            "suggestions": []
        });
        let (from, to) = stats_range_from_weekly(&weekly).unwrap();
        assert_eq!(from, "2030-01-13");
        assert_eq!(to, "2030-01-19");
    }
}
