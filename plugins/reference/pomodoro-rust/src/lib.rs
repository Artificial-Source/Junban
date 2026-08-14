//! Shipped Rust reference plugin for a host-persisted Pomodoro timer.

wit_bindgen::generate!({
    path: "wit",
    world: "reference-pomodoro",
    generate_all,
    generate_unused_types: true,
});

use exports::junban::plugin::guest::Guest;
use junban::plugin::types::*;

const TIMER_KEY: &str = "timer-state";
const STATE_BYTES: usize = 19;
const MAX_INTERVAL_SECONDS: u32 = 120 * 60;

struct Component;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Phase {
    Work,
    Break,
    LongBreak,
}

impl Phase {
    fn byte(self) -> u8 {
        match self {
            Self::Work => 0,
            Self::Break => 1,
            Self::LongBreak => 2,
        }
    }

    fn from_byte(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Work),
            1 => Some(Self::Break),
            2 => Some(Self::LongBreak),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Work => "Work",
            Self::Break => "Break",
            Self::LongBreak => "Long break",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TimerAction {
    Start,
    Pause,
    Reset,
    Skip,
}

impl TimerAction {
    fn parse(value: &str) -> Result<Self, PluginError> {
        match value {
            "start" => Ok(Self::Start),
            "pause" => Ok(Self::Pause),
            "reset" => Ok(Self::Reset),
            "skip" => Ok(Self::Skip),
            _ => Err(plugin_error(
                ErrorCode::InvalidInput,
                "action-id",
                "Unknown timer action.",
            )),
        }
    }

    fn needs_clock(self, state: TimerState) -> bool {
        matches!(self, Self::Start) || matches!(self, Self::Pause) && state.running
    }

    fn apply(self, mut state: TimerState, config: Config, now: Option<i64>) -> TimerState {
        match self {
            Self::Start => {
                let now = now.expect("start action has a clock sample");
                state.remaining_seconds = state.displayed_seconds(now);
                state.running = true;
                state.started_at_seconds = now;
            }
            Self::Pause => {
                if state.running {
                    let now = now.expect("running pause action has a clock sample");
                    state.remaining_seconds = state.displayed_seconds(now);
                }
                state.running = false;
                state.started_at_seconds = 0;
            }
            Self::Reset => {
                state.running = false;
                state.remaining_seconds = config.phase_seconds(state.phase);
                state.started_at_seconds = 0;
            }
            Self::Skip => {
                match state.phase {
                    Phase::Work => {
                        let completed = state.completed_sessions.saturating_add(1);
                        if completed >= config.sessions_before_long_break {
                            state.phase = Phase::LongBreak;
                            state.completed_sessions = 0;
                        } else {
                            state.phase = Phase::Break;
                            state.completed_sessions = completed;
                        }
                    }
                    Phase::Break | Phase::LongBreak => state.phase = Phase::Work,
                }
                state.running = false;
                state.remaining_seconds = config.phase_seconds(state.phase);
                state.started_at_seconds = 0;
            }
        }
        state
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TimerState {
    phase: Phase,
    running: bool,
    completed_sessions: u8,
    remaining_seconds: u32,
    started_at_seconds: i64,
}

impl TimerState {
    fn initial(config: Config) -> Self {
        Self {
            phase: Phase::Work,
            running: false,
            completed_sessions: 0,
            remaining_seconds: config.work_seconds,
            started_at_seconds: 0,
        }
    }

    fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != STATE_BYTES || &bytes[..4] != b"POM1" {
            return None;
        }
        let phase = Phase::from_byte(bytes[4])?;
        let running = match bytes[5] {
            0 => false,
            1 => true,
            _ => return None,
        };
        let completed_sessions = bytes[6];
        if completed_sessions > 10 {
            return None;
        }
        let remaining_seconds = u32::from_be_bytes(bytes[7..11].try_into().ok()?);
        if remaining_seconds > MAX_INTERVAL_SECONDS {
            return None;
        }
        let started_at_seconds = i64::from_be_bytes(bytes[11..19].try_into().ok()?);
        if started_at_seconds < 0 || (!running && started_at_seconds != 0) {
            return None;
        }
        Some(Self {
            phase,
            running,
            completed_sessions,
            remaining_seconds,
            started_at_seconds,
        })
    }

    fn encode(self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(STATE_BYTES);
        bytes.extend_from_slice(b"POM1");
        bytes.push(self.phase.byte());
        bytes.push(u8::from(self.running));
        bytes.push(self.completed_sessions);
        bytes.extend_from_slice(&self.remaining_seconds.to_be_bytes());
        bytes.extend_from_slice(&self.started_at_seconds.to_be_bytes());
        bytes
    }

    fn displayed_seconds(self, now_seconds: i64) -> u32 {
        if !self.running {
            return self.remaining_seconds;
        }
        let elapsed = now_seconds.saturating_sub(self.started_at_seconds).max(0) as u64;
        self.remaining_seconds
            .saturating_sub(u32::try_from(elapsed).unwrap_or(u32::MAX))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Config {
    break_seconds: u32,
    long_break_seconds: u32,
    sessions_before_long_break: u8,
    work_seconds: u32,
}

impl Config {
    fn from_values(values: &[NamedSetting]) -> Result<Self, Vec<SettingProblem>> {
        let mut issues = Vec::new();
        let break_minutes = integer_setting(
            values,
            "break-minutes",
            1,
            60,
            "Must be between 1 and 60.",
            &mut issues,
        );
        let long_break_minutes = integer_setting(
            values,
            "long-break-minutes",
            1,
            60,
            "Must be between 1 and 60.",
            &mut issues,
        );
        let sessions = integer_setting(
            values,
            "sessions-before-long-break",
            1,
            10,
            "Must be between 1 and 10.",
            &mut issues,
        );
        let work_minutes = integer_setting(
            values,
            "work-minutes",
            1,
            120,
            "Must be between 1 and 120.",
            &mut issues,
        );

        if let (Some(short), Some(long)) = (break_minutes, long_break_minutes)
            && long < short
        {
            issues.push(SettingProblem {
                setting_id: "long-break-minutes",
                message: "Must be at least Break minutes.",
            });
        }
        if !issues.is_empty() {
            return Err(issues);
        }

        let minutes_to_seconds = |minutes: i64| u32::try_from(minutes).unwrap() * 60;
        Ok(Self {
            break_seconds: minutes_to_seconds(break_minutes.unwrap()),
            long_break_seconds: minutes_to_seconds(long_break_minutes.unwrap()),
            sessions_before_long_break: u8::try_from(sessions.unwrap()).unwrap(),
            work_seconds: minutes_to_seconds(work_minutes.unwrap()),
        })
    }

    fn phase_seconds(self, phase: Phase) -> u32 {
        match phase {
            Phase::Work => self.work_seconds,
            Phase::Break => self.break_seconds,
            Phase::LongBreak => self.long_break_seconds,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SettingProblem {
    setting_id: &'static str,
    message: &'static str,
}

fn integer_setting(
    values: &[NamedSetting],
    id: &'static str,
    min: i64,
    max: i64,
    range_message: &'static str,
    issues: &mut Vec<SettingProblem>,
) -> Option<i64> {
    let mut matches = values.iter().filter(|setting| setting.id == id);
    let Some(setting) = matches.next() else {
        issues.push(SettingProblem {
            setting_id: id,
            message: "Setting is required.",
        });
        return None;
    };
    if matches.next().is_some() {
        issues.push(SettingProblem {
            setting_id: id,
            message: "Setting must appear exactly once.",
        });
        return None;
    }
    let SettingValue::Integer(value) = setting.value else {
        issues.push(SettingProblem {
            setting_id: id,
            message: "Expected an integer.",
        });
        return None;
    };
    if value < min || value > max {
        issues.push(SettingProblem {
            setting_id: id,
            message: range_message,
        });
        return None;
    }
    Some(value)
}

fn no_effect() -> PluginOutcome {
    PluginOutcome { effect: None }
}

fn plugin_error(code: ErrorCode, field: &str, message: &str) -> PluginError {
    PluginError {
        code,
        field: Some(field.into()),
        message: message.into(),
    }
}

fn unavailable(field: &str, message: &str) -> PluginError {
    plugin_error(ErrorCode::Unavailable, field, message)
}

fn current_config() -> Result<Config, PluginError> {
    let values = junban::plugin::host_settings::get_settings()
        .map_err(|_| unavailable("settings", "Current timer settings are unavailable."))?;
    Config::from_values(&values).map_err(|issues| {
        let issue = issues[0];
        plugin_error(ErrorCode::InvalidInput, issue.setting_id, issue.message)
    })
}

fn current_state(config: Config) -> Result<TimerState, PluginError> {
    // The bounded listing proves this component has not accumulated hidden KV
    // authority and retains the complete frozen host-storage interface ABI.
    let page = junban::plugin::host_storage::list_kv(None, 2)
        .map_err(|_| unavailable(TIMER_KEY, "Timer state is unavailable."))?;
    if page.next_cursor.is_some()
        || page.entries.len() > 1
        || page.entries.iter().any(|entry| entry.key != TIMER_KEY)
    {
        return Err(unavailable(
            TIMER_KEY,
            "Timer storage contains unexpected entries.",
        ));
    }
    let entries = junban::plugin::host_storage::get_kv(&[TIMER_KEY.into()])
        .map_err(|_| unavailable(TIMER_KEY, "Timer state is unavailable."))?;
    let listed = page.entries.first().map(|entry| entry.value.as_slice());
    let fetched = entries
        .iter()
        .find(|entry| entry.key == TIMER_KEY)
        .map(|entry| entry.value.as_slice());
    if listed != fetched {
        return Err(unavailable(TIMER_KEY, "Timer state changed while reading."));
    }
    Ok(fetched
        .and_then(TimerState::decode)
        .unwrap_or_else(|| TimerState::initial(config)))
}

fn wall_now_seconds() -> Result<i64, PluginError> {
    // Wall time is durable across host restarts. Bracketing it with the
    // monotonic clock rejects an internally inconsistent host clock sample.
    let before = junban::plugin::host_clock::monotonic_ms();
    let wall = junban::plugin::host_clock::wall_now();
    let after = junban::plugin::host_clock::monotonic_ms();
    if after < before {
        return Err(unavailable("clock", "The host clock moved backwards."));
    }
    parse_utc_timestamp(&wall)
        .ok_or_else(|| unavailable("clock", "The host clock returned an invalid timestamp."))
}

fn parse_utc_timestamp(value: &str) -> Option<i64> {
    let body = value.strip_suffix('Z')?;
    if body.len() < 19
        || body.as_bytes().get(4) != Some(&b'-')
        || body.as_bytes().get(7) != Some(&b'-')
        || body.as_bytes().get(10) != Some(&b'T')
        || body.as_bytes().get(13) != Some(&b':')
        || body.as_bytes().get(16) != Some(&b':')
    {
        return None;
    }
    let fraction = &body[19..];
    if !fraction.is_empty()
        && (fraction.len() < 2
            || !fraction.starts_with('.')
            || !fraction[1..].bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let number = |start: usize, end: usize| body.get(start..end)?.parse::<i64>().ok();
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

// Howard Hinnant's civil-date conversion, with 1970-01-01 as day zero.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn kv_outcome(state: TimerState) -> PluginOutcome {
    PluginOutcome {
        effect: Some(PluginEffect::KvPatch(KvPatch {
            operations: vec![KvOperation::Set(KvSet {
                key: TIMER_KEY.into(),
                value: state.encode(),
            })],
        })),
    }
}

fn apply_timer_action(action_id: &str) -> Result<PluginOutcome, PluginError> {
    let action = TimerAction::parse(action_id)?;
    let config = current_config()?;
    let state = current_state(config)?;
    let now = action
        .needs_clock(state)
        .then(wall_now_seconds)
        .transpose()?;
    Ok(kv_outcome(action.apply(state, config, now)))
}

fn display_state() -> Result<(Config, TimerState, u32), PluginError> {
    let config = current_config()?;
    let state = current_state(config)?;
    let remaining = if state.running {
        state.displayed_seconds(wall_now_seconds()?)
    } else {
        state.remaining_seconds
    };
    Ok((config, state, remaining))
}

fn formatted_duration(seconds: u32) -> String {
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn timer_surface(config: Config, state: TimerState, remaining: u32) -> Surface {
    let maximum = u16::try_from(config.phase_seconds(state.phase)).unwrap();
    let remaining = u16::try_from(remaining.min(u32::from(maximum))).unwrap();
    Surface {
        surface_id: "timer".into(),
        root_index: 0,
        nodes: vec![
            UiNode {
                id: "timer-root".into(),
                parent_index: None,
                content: UiContent::Stack(LayoutProps {
                    gap: 3,
                    align: UiAlign::Stretch,
                }),
            },
            UiNode {
                id: "timer-heading".into(),
                parent_index: Some(0),
                content: UiContent::Heading(TextProps {
                    text: "Pomodoro".into(),
                    tone: UiTone::Neutral,
                    size: UiSize::Large,
                }),
            },
            UiNode {
                id: "timer-value".into(),
                parent_index: Some(0),
                content: UiContent::Metric(MetricProps {
                    label: state.phase.label().into(),
                    value: formatted_duration(u32::from(remaining)),
                    tone: if state.running {
                        UiTone::Accent
                    } else {
                        UiTone::Neutral
                    },
                }),
            },
            UiNode {
                id: "timer-progress".into(),
                parent_index: Some(0),
                content: UiContent::Progress(ProgressProps {
                    label: "Interval progress".into(),
                    value: maximum.saturating_sub(remaining),
                    maximum,
                }),
            },
            UiNode {
                id: "timer-actions".into(),
                parent_index: Some(0),
                content: UiContent::Row(LayoutProps {
                    gap: 2,
                    align: UiAlign::Center,
                }),
            },
            button_node("timer-start", 4, "Start", "start", UiTone::Accent),
            button_node("timer-pause", 4, "Pause", "pause", UiTone::Neutral),
            button_node("timer-reset", 4, "Reset", "reset", UiTone::Neutral),
            button_node("timer-skip", 4, "Skip", "skip", UiTone::Neutral),
        ],
    }
}

fn status_surface(state: TimerState, remaining: u32) -> Surface {
    Surface {
        surface_id: "status".into(),
        root_index: 0,
        nodes: vec![
            UiNode {
                id: "status-root".into(),
                parent_index: None,
                content: UiContent::Row(LayoutProps {
                    gap: 2,
                    align: UiAlign::Center,
                }),
            },
            UiNode {
                id: "status-value".into(),
                parent_index: Some(0),
                content: UiContent::Metric(MetricProps {
                    label: state.phase.label().into(),
                    value: formatted_duration(remaining),
                    tone: if state.running {
                        UiTone::Accent
                    } else {
                        UiTone::Neutral
                    },
                }),
            },
            button_node("status-start", 0, "Start", "start", UiTone::Accent),
            button_node("status-pause", 0, "Pause", "pause", UiTone::Neutral),
        ],
    }
}

fn button_node(id: &str, parent_index: u16, label: &str, action_id: &str, tone: UiTone) -> UiNode {
    UiNode {
        id: id.into(),
        parent_index: Some(parent_index),
        content: UiContent::Button(ButtonProps {
            label: label.into(),
            action_id: action_id.into(),
            tone,
            icon: None,
        }),
    }
}

fn action_is_declared(surface_id: &str, action_id: &str) -> bool {
    match surface_id {
        "timer" => matches!(action_id, "pause" | "reset" | "skip" | "start"),
        "status" => matches!(action_id, "pause" | "start"),
        _ => false,
    }
}

impl Guest for Component {
    fn activate(_context: InvocationContext) -> Result<(), PluginError> {
        Ok(())
    }

    fn deactivate(_context: InvocationContext) -> Result<(), PluginError> {
        Ok(())
    }

    fn invoke_command(
        _context: InvocationContext,
        call: CommandCall,
    ) -> Result<PluginOutcome, PluginError> {
        if !call.values.is_empty() {
            return Err(plugin_error(
                ErrorCode::InvalidInput,
                "values",
                "Timer commands do not accept values.",
            ));
        }
        apply_timer_action(&call.command_id)
    }

    fn handle_event(
        _context: InvocationContext,
        _event: EventEnvelope,
    ) -> Result<PluginOutcome, PluginError> {
        Ok(no_effect())
    }

    fn render_surface(
        _context: InvocationContext,
        request: SurfaceRequest,
    ) -> Result<Surface, PluginError> {
        let (config, state, remaining) = display_state()?;
        match request.surface_id.as_str() {
            "timer" => Ok(timer_surface(config, state, remaining)),
            "status" => Ok(status_surface(state, remaining)),
            _ => Err(plugin_error(
                ErrorCode::NotFound,
                "surface-id",
                "Unknown timer surface.",
            )),
        }
    }

    fn handle_surface_action(
        _context: InvocationContext,
        action: SurfaceAction,
    ) -> Result<PluginOutcome, PluginError> {
        if !action.values.is_empty() {
            return Err(plugin_error(
                ErrorCode::InvalidInput,
                "values",
                "Timer actions do not accept values.",
            ));
        }
        if !action_is_declared(&action.surface_id, &action.action_id) {
            return Err(plugin_error(
                ErrorCode::InvalidInput,
                "action-id",
                "The action is not declared for this surface.",
            ));
        }
        apply_timer_action(&action.action_id)
    }

    fn validate_settings(
        _context: InvocationContext,
        values: SettingValues,
    ) -> Result<Vec<ValidationIssue>, PluginError> {
        Ok(match Config::from_values(&values.values) {
            Ok(_) => Vec::new(),
            Err(issues) => issues
                .into_iter()
                .map(|issue| ValidationIssue {
                    setting_id: issue.setting_id.into(),
                    message: issue.message.into(),
                })
                .collect(),
        })
    }

    fn resync(
        _context: InvocationContext,
        page: ResyncPage,
    ) -> Result<ResyncPageOutcome, PluginError> {
        Ok(match page {
            ResyncPage::Snapshot(page) => ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: page.session_id,
                page_index: page.page_index,
                kind: page.kind,
                segment: None,
            }),
            ResyncPage::FlushStagedKv(page) => ResyncPageOutcome::FlushAck(FlushAck {
                session_id: page.session_id,
                request_index: page.request_index,
                segment: None,
                state: FlushState::Complete,
            }),
            ResyncPage::Finalize(page) => ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: page.session_id,
                choice: FinalKvChoice::LeaveKv,
            }),
        })
    }

    fn call_service(
        _context: InvocationContext,
        _call: ServiceCall,
    ) -> Result<ServiceData, PluginError> {
        Ok(ServiceData { values: Vec::new() })
    }
}

export!(Component);

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(short: i64, long: i64, sessions: i64, work: i64) -> Vec<NamedSetting> {
        [
            ("break-minutes", short),
            ("long-break-minutes", long),
            ("sessions-before-long-break", sessions),
            ("work-minutes", work),
        ]
        .into_iter()
        .map(|(id, value)| NamedSetting {
            id: id.into(),
            value: SettingValue::Integer(value),
        })
        .collect()
    }

    fn config() -> Config {
        Config::from_values(&settings(5, 15, 4, 25)).unwrap()
    }

    #[test]
    fn state_encoding_is_compact_deterministic_and_fail_closed() {
        let state = TimerState {
            phase: Phase::Break,
            running: true,
            completed_sessions: 2,
            remaining_seconds: 299,
            started_at_seconds: 1_893_456_000,
        };
        let bytes = state.encode();
        assert_eq!(bytes.len(), STATE_BYTES);
        assert_eq!(TimerState::decode(&bytes), Some(state));

        let mut invalid = bytes;
        invalid[4] = 9;
        assert_eq!(TimerState::decode(&invalid), None);
        assert_eq!(TimerState::decode(b"untrusted"), None);
    }

    #[test]
    fn elapsed_time_clamps_at_zero_and_at_the_interval_end() {
        let state = TimerState {
            phase: Phase::Work,
            running: true,
            completed_sessions: 0,
            remaining_seconds: 10,
            started_at_seconds: 100,
        };
        assert_eq!(state.displayed_seconds(90), 10);
        assert_eq!(state.displayed_seconds(104), 6);
        assert_eq!(state.displayed_seconds(200), 0);
    }

    #[test]
    fn timer_actions_have_deterministic_start_pause_reset_and_skip_semantics() {
        let config = config();
        let initial = TimerState::initial(config);
        let running = TimerAction::Start.apply(initial, config, Some(100));
        assert!(running.running);
        assert_eq!(running.started_at_seconds, 100);

        let paused = TimerAction::Pause.apply(running, config, Some(110));
        assert!(!paused.running);
        assert_eq!(paused.remaining_seconds, config.work_seconds - 10);
        assert_eq!(paused.started_at_seconds, 0);

        let reset = TimerAction::Reset.apply(paused, config, None);
        assert_eq!(reset.remaining_seconds, config.work_seconds);

        let before_long_break = TimerState {
            completed_sessions: config.sessions_before_long_break - 1,
            ..reset
        };
        let long_break = TimerAction::Skip.apply(before_long_break, config, None);
        assert_eq!(long_break.phase, Phase::LongBreak);
        assert_eq!(long_break.completed_sessions, 0);
        assert_eq!(long_break.remaining_seconds, config.long_break_seconds);

        let work = TimerAction::Skip.apply(long_break, config, None);
        assert_eq!(work.phase, Phase::Work);
        assert_eq!(work.remaining_seconds, config.work_seconds);
    }

    #[test]
    fn settings_validate_missing_type_range_and_cross_field_errors() {
        assert!(Config::from_values(&settings(5, 15, 4, 25)).is_ok());

        let missing = Config::from_values(&settings(5, 15, 4, 25)[1..]).unwrap_err();
        assert_eq!(missing[0].setting_id, "break-minutes");

        let mut wrong_type = settings(5, 15, 4, 25);
        wrong_type[0].value = SettingValue::Boolean(true);
        assert_eq!(
            Config::from_values(&wrong_type).unwrap_err()[0].message,
            "Expected an integer."
        );

        assert_eq!(
            Config::from_values(&settings(0, 15, 4, 25)).unwrap_err()[0].message,
            "Must be between 1 and 60."
        );
        assert!(
            Config::from_values(&settings(20, 15, 4, 25))
                .unwrap_err()
                .iter()
                .any(|issue| issue.setting_id == "long-break-minutes")
        );
    }

    #[test]
    fn utc_timestamp_parser_handles_fractional_seconds_and_calendar_bounds() {
        assert_eq!(parse_utc_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc_timestamp("1970-01-01T00:00:01.123Z"), Some(1));
        assert_eq!(
            parse_utc_timestamp("2000-02-29T12:00:00Z"),
            Some(951_825_600)
        );
        assert_eq!(parse_utc_timestamp("2023-02-29T12:00:00Z"), None);
        assert_eq!(parse_utc_timestamp("2030-01-02T03:04:60Z"), None);
    }

    #[test]
    fn surfaces_are_flat_bounded_and_use_only_declared_actions() {
        let config = config();
        let state = TimerState::initial(config);
        let timer = timer_surface(config, state, state.remaining_seconds);
        assert_eq!(timer.root_index, 0);
        assert!(timer.nodes.len() <= 256);
        for (index, node) in timer.nodes.iter().enumerate().skip(1) {
            assert!(usize::from(node.parent_index.unwrap()) < index);
            if let UiContent::Button(button) = &node.content {
                assert!(action_is_declared("timer", &button.action_id));
            }
        }

        let status = status_surface(state, state.remaining_seconds);
        for node in &status.nodes {
            if let UiContent::Button(button) = &node.content {
                assert!(action_is_declared("status", &button.action_id));
            }
        }
    }
}
