//! Ergonomic planning and motivation commands.

use serde_json::{Map, Value, json};

use crate::commands::{call_and_emit_view, insert_opt_str, insert_opt_u32, validate_date_arg};
use crate::error::CliError;
use crate::output::OutputMode;
use crate::render::HumanView;
use crate::session::Session;

async fn dated(
    session: &mut Session,
    mode: OutputMode,
    tool: &str,
    date: Option<String>,
    capacity_minutes: Option<u32>,
    view: HumanView,
) -> Result<(), CliError> {
    let mut map = Map::new();
    if let Some(date) = date {
        let date = validate_date_arg(&date, "date")?;
        map.insert("date".into(), Value::String(date));
    }
    insert_opt_u32(&mut map, "capacity_minutes", capacity_minutes);
    call_and_emit_view(session, mode, tool, Value::Object(map), view).await
}

pub async fn daily(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
    capacity_minutes: Option<u32>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "planning_daily",
        date,
        capacity_minutes,
        HumanView::DailyPlan,
    )
    .await
}

pub async fn end_of_day(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
    capacity_minutes: Option<u32>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "planning_end_of_day",
        date,
        capacity_minutes,
        HumanView::EndOfDay,
    )
    .await
}

pub async fn weekly(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "planning_weekly",
        date,
        None,
        HumanView::Weekly,
    )
    .await
}

pub async fn calendar(
    session: &mut Session,
    mode: OutputMode,
    from: String,
    to: String,
    project_id: Option<String>,
) -> Result<(), CliError> {
    let from = validate_date_arg(&from, "from")?;
    let to = validate_date_arg(&to, "to")?;
    let mut map = Map::new();
    map.insert("from".into(), Value::String(from));
    map.insert("to".into(), Value::String(to));
    insert_opt_str(&mut map, "project_id", project_id);
    call_and_emit_view(
        session,
        mode,
        "calendar_tasks",
        Value::Object(map),
        HumanView::Calendar,
    )
    .await
}

pub async fn stats(
    session: &mut Session,
    mode: OutputMode,
    from: String,
    to: String,
) -> Result<(), CliError> {
    let from = validate_date_arg(&from, "from")?;
    let to = validate_date_arg(&to, "to")?;
    call_and_emit_view(
        session,
        mode,
        "stats",
        json!({ "from": from, "to": to }),
        HumanView::Stats,
    )
    .await
}

pub async fn nudges(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
    capacity_minutes: Option<u32>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "nudges",
        date,
        capacity_minutes,
        HumanView::Nudges,
    )
    .await
}

pub async fn eat_the_frog(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "motivation_eat_the_frog",
        date,
        None,
        HumanView::EatTheFrog,
    )
    .await
}

pub async fn task_jar(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "motivation_task_jar",
        date,
        None,
        HumanView::TaskJar,
    )
    .await
}

pub async fn dopamine(
    session: &mut Session,
    mode: OutputMode,
    date: Option<String>,
) -> Result<(), CliError> {
    dated(
        session,
        mode,
        "motivation_dopamine_menu",
        date,
        None,
        HumanView::Dopamine,
    )
    .await
}
