//! Typed application settings aggregate and patch validation.
//!
//! Settings are the sole authority for appearance, temporal defaults, feature
//! visibility, planning capacity, notifications, and custom keyboard shortcuts.
//! Storage persists one JSON blob; this module owns shape and validation only.

use serde::{Deserialize, Serialize};

use crate::ai::{AiSettings, VoiceSettings};
use crate::{
    EstimatedMinutes, HexColor, NudgeRuleKind, NudgeRuleSettings, Priority, ReminderChannel,
    ReminderChannelSet, TaskViewPreset, ValidationError, WeekStart, WorkHours,
};

/// Daily planning capacity bounds accepted by settings (minutes).
pub const MIN_CAPACITY_MINUTES: u32 = 60;
pub const MAX_CAPACITY_MINUTES: u32 = 1440;

/// Browser chords that must never be claimed by the application.
pub const RESERVED_BROWSER_CHORDS: &[&str] = &[
    "cmd+t",
    "cmd+w",
    "cmd+n",
    "cmd+d",
    "cmd+l",
    "cmd+r",
    "cmd+shift+r",
    "cmd+shift+t",
    "cmd+shift+n",
    "f5",
    "f11",
    "f12",
];

/// Commands currently owned by `AppLayout` and therefore safe to persist.
pub const KEYBOARD_SHORTCUT_ACTIONS: &[&str] = &[
    "quick-add",
    "search",
    "command-palette",
    "new-project",
    "undo",
    "redo",
    "today",
    "inbox",
    "upcoming",
    "someday",
    "completed",
    "cancelled",
    "filters",
    "focus-mode",
    "plan-my-day",
    "end-of-day",
    "weekly-review",
];

// ── Appearance ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    System,
    Light,
    Dark,
    Nord,
}

impl Theme {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "system" => Ok(Self::System),
            "light" => Ok(Self::Light),
            "dark" => Ok(Self::Dark),
            "nord" => Ok(Self::Nord),
            _ => Err(ValidationError::InvalidFormat {
                field: "theme",
                expected: "system|light|dark|nord",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
            Self::Nord => "nord",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Density {
    Compact,
    Default,
    Comfortable,
}

impl Density {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "compact" => Ok(Self::Compact),
            "default" => Ok(Self::Default),
            "comfortable" => Ok(Self::Comfortable),
            _ => Err(ValidationError::InvalidFormat {
                field: "density",
                expected: "compact|default|comfortable",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::Default => "default",
            Self::Comfortable => "comfortable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontSize {
    Small,
    Medium,
    Large,
}

impl FontSize {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "small" => Ok(Self::Small),
            "medium" => Ok(Self::Medium),
            "large" => Ok(Self::Large),
            _ => Err(ValidationError::InvalidFormat {
                field: "font_size",
                expected: "small|medium|large",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Large => "large",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontFamily {
    Outfit,
    Inter,
    System,
}

impl FontFamily {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "outfit" => Ok(Self::Outfit),
            "inter" => Ok(Self::Inter),
            "system" => Ok(Self::System),
            _ => Err(ValidationError::InvalidFormat {
                field: "font_family",
                expected: "outfit|inter|system",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Outfit => "outfit",
            Self::Inter => "inter",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppearanceSettings {
    pub theme: Theme,
    pub accent: HexColor,
    pub density: Density,
    pub font_size: FontSize,
    pub font_family: FontFamily,
    pub reduced_motion: bool,
}

impl AppearanceSettings {
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            // Phase 3-preserving defaults. System/Default remain selectable options.
            theme: Theme::Light,
            accent: HexColor::new("#3b82f6").expect("default accent is valid"),
            density: Density::Comfortable,
            font_size: FontSize::Medium,
            font_family: FontFamily::Outfit,
            reduced_motion: false,
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        // `HexColor` uses transparent serde for transport reuse, so validate the
        // inner value again after deserialization instead of trusting construction.
        HexColor::new(self.accent.as_str()).map_err(|_| ValidationError::InvalidFormat {
            field: "accent",
            expected: "#RRGGBB",
        })?;
        let _ = self.theme.as_str();
        let _ = self.density.as_str();
        let _ = self.font_size.as_str();
        let _ = self.font_family.as_str();
        Ok(())
    }
}

// ── Date & time ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalendarDefault {
    Day,
    Week,
    Month,
}

impl CalendarDefault {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "day" => Ok(Self::Day),
            "week" => Ok(Self::Week),
            "month" => Ok(Self::Month),
            _ => Err(ValidationError::InvalidFormat {
                field: "calendar_default",
                expected: "day|week|month",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateFormat {
    Relative,
    Short,
    Long,
    Iso,
}

impl DateFormat {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "relative" => Ok(Self::Relative),
            "short" => Ok(Self::Short),
            "long" => Ok(Self::Long),
            "iso" => Ok(Self::Iso),
            _ => Err(ValidationError::InvalidFormat {
                field: "date_format",
                expected: "relative|short|long|iso",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Relative => "relative",
            Self::Short => "short",
            Self::Long => "long",
            Self::Iso => "iso",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeFormat {
    H24,
    H12,
}

impl TimeFormat {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "h24" => Ok(Self::H24),
            "h12" => Ok(Self::H12),
            _ => Err(ValidationError::InvalidFormat {
                field: "time_format",
                expected: "h24|h12",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::H24 => "h24",
            Self::H12 => "h12",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DateTimeSettings {
    pub week_start: WeekStart,
    pub calendar_default: CalendarDefault,
    pub date_format: DateFormat,
    pub time_format: TimeFormat,
}

impl DateTimeSettings {
    /// Default temporal display preferences.
    ///
    /// Civil-date authority remains the server-local/system zone; it is not a
    /// persisted user setting.
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            week_start: WeekStart::Sunday,
            calendar_default: CalendarDefault::Week,
            // Short replaces removed locale semantics; Relative/H12 remain selectable.
            date_format: DateFormat::Short,
            time_format: TimeFormat::H24,
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        let _ = self.week_start;
        let _ = self.calendar_default.as_str();
        let _ = self.date_format.as_str();
        let _ = self.time_format.as_str();
        Ok(())
    }
}

// ── Task defaults ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_priority: Option<Priority>,
    pub default_view: TaskViewPreset,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_estimated_minutes: Option<EstimatedMinutes>,
    pub confirm_before_delete: bool,
}

impl TaskDefaults {
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            default_priority: None,
            default_view: TaskViewPreset::Today,
            default_estimated_minutes: None,
            confirm_before_delete: true,
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        Ok(())
    }
}

// ── Keyboard ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyboardShortcut {
    /// Stable hyphenated `AppLayout` command id.
    pub action: String,
    /// Platform-independent canonical chord (`cmd+k`, `g t`, …).
    pub chord: String,
}

impl KeyboardShortcut {
    pub fn new(
        action: impl Into<String>,
        chord: impl Into<String>,
    ) -> Result<Self, ValidationError> {
        let action = canonicalize_shortcut_action(&action.into())?;
        let chord = canonicalize_chord(&chord.into())?;
        let shortcut = Self { action, chord };
        shortcut.validate()?;
        Ok(shortcut)
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        let action = canonicalize_shortcut_action(&self.action)?;
        if action != self.action {
            return Err(ValidationError::InvalidFormat {
                field: "keyboard_shortcut.action",
                expected: "a canonical supported action id",
            });
        }
        let chord = canonicalize_chord(&self.chord)?;
        if chord != self.chord {
            return Err(ValidationError::InvalidFormat {
                field: "keyboard_shortcut.chord",
                expected: "a canonical shortcut chord",
            });
        }
        if is_reserved_browser_chord(&chord) {
            return Err(ValidationError::Invalid {
                field: "keyboard_shortcut.chord",
                reason: "chord is reserved by the browser",
            });
        }
        Ok(())
    }
}

fn canonicalize_shortcut_action(action: &str) -> Result<String, ValidationError> {
    let mut canonical = String::new();
    let mut separator = false;
    for character in action.trim().chars() {
        if character == '_' || character == '-' || character.is_ascii_whitespace() {
            separator = !canonical.is_empty();
            continue;
        }
        if !character.is_ascii_alphanumeric() {
            return Err(ValidationError::InvalidFormat {
                field: "keyboard_shortcut.action",
                expected: "a supported action id",
            });
        }
        if separator {
            canonical.push('-');
            separator = false;
        }
        canonical.push(character.to_ascii_lowercase());
    }
    if canonical.is_empty() {
        return Err(ValidationError::Empty {
            field: "keyboard_shortcut.action",
        });
    }
    if !KEYBOARD_SHORTCUT_ACTIONS.contains(&canonical.as_str()) {
        return Err(ValidationError::Invalid {
            field: "keyboard_shortcut.action",
            reason: "action is not supported",
        });
    }
    Ok(canonical)
}

fn canonicalize_chord(chord: &str) -> Result<String, ValidationError> {
    let compact = chord.trim().replace(" +", "+").replace("+ ", "+");
    let strokes: Vec<_> = compact.split_ascii_whitespace().collect();
    if strokes.is_empty() {
        return Err(ValidationError::Empty {
            field: "keyboard_shortcut.chord",
        });
    }
    if strokes.len() > 2 {
        return Err(malformed_chord());
    }
    strokes
        .into_iter()
        .map(canonicalize_stroke)
        .collect::<Result<Vec<_>, _>>()
        .map(|strokes| strokes.join(" "))
}

fn canonicalize_stroke(stroke: &str) -> Result<String, ValidationError> {
    let parts: Vec<_> = stroke.split('+').collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(malformed_chord());
    }

    let mut cmd = false;
    let mut shift = false;
    let mut key: Option<String> = None;
    for part in parts {
        let part = part.to_ascii_lowercase();
        match part.as_str() {
            "cmd" | "command" | "control" | "ctrl" | "ctl" | "meta" | "super" | "win" => {
                if cmd {
                    return Err(malformed_chord());
                }
                cmd = true;
            }
            "shift" => {
                if shift {
                    return Err(malformed_chord());
                }
                shift = true;
            }
            "alt" | "option" => return Err(malformed_chord()),
            value if is_valid_shortcut_key(value) && key.is_none() => key = Some(value.to_owned()),
            _ => return Err(malformed_chord()),
        }
    }
    let key = key.ok_or_else(malformed_chord)?;
    let mut canonical = Vec::with_capacity(3);
    if cmd {
        canonical.push("cmd".to_owned());
    }
    if shift {
        canonical.push("shift".to_owned());
    }
    canonical.push(key);
    Ok(canonical.join("+"))
}

fn is_valid_shortcut_key(value: &str) -> bool {
    (value.len() == 1 && value.as_bytes()[0].is_ascii_alphanumeric())
        || matches!(
            value,
            "space"
                | "enter"
                | "escape"
                | "tab"
                | "arrowup"
                | "arrowdown"
                | "arrowleft"
                | "arrowright"
                | "home"
                | "end"
                | "pageup"
                | "pagedown"
                | "delete"
                | "backspace"
                | "f1"
                | "f2"
                | "f3"
                | "f4"
                | "f5"
                | "f6"
                | "f7"
                | "f8"
                | "f9"
                | "f10"
                | "f11"
                | "f12"
        )
}

fn malformed_chord() -> ValidationError {
    ValidationError::InvalidFormat {
        field: "keyboard_shortcut.chord",
        expected: "cmd/shift modifiers plus a key, or a two-key chord",
    }
}

/// Normalize supported aliases to the persisted platform-independent spelling.
#[must_use]
pub fn normalize_chord(chord: &str) -> String {
    canonicalize_chord(chord).unwrap_or_default()
}

#[must_use]
pub fn is_reserved_browser_chord(chord: &str) -> bool {
    let normalized = normalize_chord(chord);
    !normalized.is_empty() && RESERVED_BROWSER_CHORDS.contains(&normalized.as_str())
}

// ── Notifications ───────────────────────────────────────────────────────────

/// Master sound volume as a whole percent in `0..=100`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VolumePercent(u8);

impl VolumePercent {
    pub const MIN: u8 = 0;
    pub const MAX: u8 = 100;
    pub const DEFAULT: Self = Self(70);

    pub fn new(value: u8) -> Result<Self, ValidationError> {
        if value > Self::MAX {
            return Err(ValidationError::OutOfRange {
                field: "volume_percent",
                min: i64::from(Self::MIN),
                max: i64::from(Self::MAX),
            });
        }
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationSettings {
    pub channels: ReminderChannelSet,
    pub sound_enabled: bool,
    pub volume_percent: VolumePercent,
    pub task_completed_sound: bool,
    pub task_created_sound: bool,
    pub task_deleted_sound: bool,
    pub reminder_sound: bool,
}

impl NotificationSettings {
    pub fn default_settings() -> Result<Self, ValidationError> {
        let channels =
            ReminderChannelSet::new(vec![ReminderChannel::InApp, ReminderChannel::Sound])?;
        Ok(Self {
            channels,
            sound_enabled: true,
            volume_percent: VolumePercent::DEFAULT,
            task_completed_sound: true,
            task_created_sound: true,
            task_deleted_sound: true,
            reminder_sound: true,
        })
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.channels.as_slice().is_empty() {
            return Err(ValidationError::Empty {
                field: "notification_channels",
            });
        }
        // Transparent serde can admit out-of-range values; re-check construction.
        VolumePercent::new(self.volume_percent.get())?;
        Ok(())
    }
}

// ── Features ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FeatureSettings {
    pub nudges_enabled: bool,
    pub eat_the_frog_enabled: bool,
    pub task_jar_enabled: bool,
    pub focus_mode_enabled: bool,
    pub daily_planning_enabled: bool,
    pub weekly_review_enabled: bool,
}

impl FeatureSettings {
    /// Phase 3 feature visibility defaults.
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            nudges_enabled: true,
            eat_the_frog_enabled: false,
            task_jar_enabled: false,
            focus_mode_enabled: false,
            daily_planning_enabled: true,
            weekly_review_enabled: true,
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        Ok(())
    }
}

// ── Planning ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanningSettings {
    pub capacity_minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_hours: Option<WorkHours>,
    pub nudge_rules: Vec<NudgeRuleSettings>,
}

impl PlanningSettings {
    #[must_use]
    pub fn default_settings() -> Self {
        Self {
            capacity_minutes: 480,
            work_hours: None,
            nudge_rules: default_nudge_rules(),
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        if !(MIN_CAPACITY_MINUTES..=MAX_CAPACITY_MINUTES).contains(&self.capacity_minutes) {
            return Err(ValidationError::OutOfRange {
                field: "capacity_minutes",
                min: i64::from(MIN_CAPACITY_MINUTES),
                max: i64::from(MAX_CAPACITY_MINUTES),
            });
        }
        if let Some(hours) = self.work_hours {
            // Re-validate bounds even when constructed outside WorkHours::new.
            WorkHours::new(hours.start_minute, hours.end_minute)?;
        }
        let mut seen = Vec::with_capacity(self.nudge_rules.len());
        for rule in &self.nudge_rules {
            if seen.contains(&rule.kind) {
                return Err(ValidationError::Duplicate {
                    field: "nudge_rules",
                });
            }
            seen.push(rule.kind);
            let _ = rule.kind.as_str();
            // Only stale_task evaluation consumes a threshold. Reject inert values
            // so they cannot be persisted as if they were authoritative.
            if rule.threshold.is_some() && rule.kind != NudgeRuleKind::StaleTask {
                return Err(ValidationError::Invalid {
                    field: "nudge_rules.threshold",
                    reason: "only stale_task may carry a threshold",
                });
            }
        }
        Ok(())
    }
}

fn default_nudge_rules() -> Vec<NudgeRuleSettings> {
    NudgeRuleKind::ALL
        .into_iter()
        .map(|kind| {
            let threshold = match kind {
                NudgeRuleKind::StaleTask => Some(14),
                _ => None,
            };
            NudgeRuleSettings::new(kind, true, threshold)
        })
        .collect()
}

// ── Aggregate ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSettings {
    pub appearance: AppearanceSettings,
    pub date_time: DateTimeSettings,
    pub task_defaults: TaskDefaults,
    pub notifications: NotificationSettings,
    pub features: FeatureSettings,
    pub planning: PlanningSettings,
    pub keyboard_shortcuts: Vec<KeyboardShortcut>,
    /// Defaults leave cloud AI disabled when absent from older snapshots.
    #[serde(default)]
    pub ai: AiSettings,
    /// Defaults leave cloud speech disabled when absent from older snapshots.
    #[serde(default)]
    pub voice: VoiceSettings,
}

impl AppSettings {
    /// Phase 3-preserving defaults for persisted settings authorities.
    pub fn default_settings() -> Self {
        Self {
            appearance: AppearanceSettings::default_settings(),
            date_time: DateTimeSettings::default_settings(),
            task_defaults: TaskDefaults::default_settings(),
            notifications: NotificationSettings::default_settings()
                .expect("default notification channels are valid"),
            features: FeatureSettings::default_settings(),
            planning: PlanningSettings::default_settings(),
            keyboard_shortcuts: default_keyboard_shortcuts(),
            ai: AiSettings::default_settings(),
            voice: VoiceSettings::default_settings(),
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        self.appearance.validate()?;
        self.date_time.validate()?;
        self.task_defaults.validate()?;
        self.notifications.validate()?;
        self.features.validate()?;
        self.planning.validate()?;
        validate_keyboard_shortcuts(&self.keyboard_shortcuts)?;
        self.ai.validate()?;
        self.voice.validate()?;
        Ok(())
    }

    /// Merge a section-level patch and validate the resulting aggregate.
    pub fn apply_patch(&self, patch: &SettingsPatch) -> Result<Self, ValidationError> {
        patch.validate()?;
        let mut next = self.clone();
        if let Some(appearance) = &patch.appearance {
            next.appearance = appearance.clone();
        }
        if let Some(date_time) = &patch.date_time {
            next.date_time = date_time.clone();
        }
        if let Some(task_defaults) = &patch.task_defaults {
            next.task_defaults = task_defaults.clone();
        }
        if let Some(notifications) = &patch.notifications {
            next.notifications = notifications.clone();
        }
        if let Some(features) = &patch.features {
            next.features = features.clone();
        }
        if let Some(planning) = &patch.planning {
            next.planning = planning.clone();
        }
        if let Some(keyboard_shortcuts) = &patch.keyboard_shortcuts {
            next.keyboard_shortcuts = keyboard_shortcuts.clone();
        }
        if let Some(ai) = &patch.ai {
            next.ai = ai.clone();
        }
        if let Some(voice) = &patch.voice {
            next.voice = voice.clone();
        }
        next.validate()?;
        Ok(next)
    }

    /// Candidate-restore sanitization: drop credential bindings and force AI/cloud
    /// speech disabled while preserving non-secret preferences.
    #[must_use]
    pub fn cleared_for_restore(&self) -> Self {
        let mut next = self.clone();
        next.ai = self.ai.cleared_for_restore();
        next.voice = self.voice.cleared_for_restore();
        next
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self::default_settings()
    }
}

fn default_keyboard_shortcuts() -> Vec<KeyboardShortcut> {
    [
        ("quick-add", "cmd+a"),
        ("search", "cmd+k"),
        ("command-palette", "cmd+shift+p"),
        ("new-project", "g n"),
        ("undo", "cmd+z"),
        ("redo", "cmd+shift+z"),
        ("today", "g t"),
        ("inbox", "g i"),
        ("upcoming", "g u"),
        ("someday", "g s"),
        ("completed", "g c"),
        ("cancelled", "g x"),
        ("filters", "g f"),
        ("focus-mode", "cmd+shift+f"),
        ("plan-my-day", "g p"),
        ("end-of-day", "g e"),
        ("weekly-review", "g w"),
    ]
    .into_iter()
    .map(|(action, chord)| KeyboardShortcut::new(action, chord).expect("default shortcut is valid"))
    .collect()
}

fn validate_keyboard_shortcuts(shortcuts: &[KeyboardShortcut]) -> Result<(), ValidationError> {
    let mut seen_actions = Vec::with_capacity(shortcuts.len());
    let mut seen_chords = Vec::with_capacity(shortcuts.len());
    for shortcut in shortcuts {
        shortcut.validate()?;
        if seen_actions.contains(&shortcut.action) {
            return Err(ValidationError::Duplicate {
                field: "keyboard_shortcuts.action",
            });
        }
        if seen_chords.contains(&shortcut.chord) {
            return Err(ValidationError::Duplicate {
                field: "keyboard_shortcuts.chord",
            });
        }
        seen_actions.push(shortcut.action.clone());
        seen_chords.push(shortcut.chord.clone());
    }

    for chord in &seen_chords {
        if !chord.contains(' ')
            && seen_chords
                .iter()
                .any(|candidate| candidate.starts_with(&format!("{chord} ")))
        {
            return Err(ValidationError::Invalid {
                field: "keyboard_shortcuts.chord",
                reason: "single-key shortcut conflicts with a chord prefix",
            });
        }
    }
    Ok(())
}

// ── Patch ───────────────────────────────────────────────────────────────────

/// Section-level settings patch. `None` leaves a section unchanged; `Some` replaces it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<AppearanceSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_time: Option<DateTimeSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_defaults: Option<TaskDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<NotificationSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub features: Option<FeatureSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<PlanningSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard_shortcuts: Option<Vec<KeyboardShortcut>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<AiSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceSettings>,
}

impl SettingsPatch {
    /// Validate only the sections present in the patch (before merge).
    pub fn validate(&self) -> Result<(), ValidationError> {
        if let Some(appearance) = &self.appearance {
            appearance.validate()?;
        }
        if let Some(date_time) = &self.date_time {
            date_time.validate()?;
        }
        if let Some(task_defaults) = &self.task_defaults {
            task_defaults.validate()?;
        }
        if let Some(notifications) = &self.notifications {
            notifications.validate()?;
        }
        if let Some(features) = &self.features {
            features.validate()?;
        }
        if let Some(planning) = &self.planning {
            planning.validate()?;
        }
        if let Some(shortcuts) = &self.keyboard_shortcuts {
            validate_keyboard_shortcuts(shortcuts)?;
        }
        if let Some(ai) = &self.ai {
            ai.validate()?;
        }
        if let Some(voice) = &self.voice {
            voice.validate()?;
        }
        Ok(())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.appearance.is_none()
            && self.date_time.is_none()
            && self.task_defaults.is_none()
            && self.notifications.is_none()
            && self.features.is_none()
            && self.planning.is_none()
            && self.keyboard_shortcuts.is_none()
            && self.ai.is_none()
            && self.voice.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReminderChannel;

    #[test]
    fn defaults_preserve_phase_3_temporal_behavior() {
        let settings = AppSettings::default_settings();
        assert_eq!(settings.date_time.week_start, WeekStart::Sunday);
        assert_eq!(settings.date_time.calendar_default, CalendarDefault::Week);
        assert_eq!(settings.planning.capacity_minutes, 480);
        assert!(settings.planning.work_hours.is_none());
        assert!(settings.features.nudges_enabled);
        assert!(!settings.features.eat_the_frog_enabled);
        assert!(!settings.features.task_jar_enabled);
        assert_eq!(settings.appearance.theme, Theme::Light);
        assert_eq!(settings.appearance.accent.as_str(), "#3b82f6");
        assert_eq!(settings.appearance.density, Density::Comfortable);
        assert_eq!(settings.appearance.font_size, FontSize::Medium);
        assert_eq!(settings.appearance.font_family, FontFamily::Outfit);
        assert_eq!(settings.date_time.date_format, DateFormat::Short);
        assert_eq!(settings.date_time.time_format, TimeFormat::H24);
        assert_eq!(settings.task_defaults.default_view, TaskViewPreset::Today);
        assert!(settings.task_defaults.default_priority.is_none());
        assert!(settings.task_defaults.default_estimated_minutes.is_none());
        assert!(settings.task_defaults.confirm_before_delete);
        assert!(settings.notifications.sound_enabled);
        assert_eq!(
            settings.notifications.channels.as_slice(),
            &[ReminderChannel::InApp, ReminderChannel::Sound]
        );
        assert_eq!(settings.notifications.volume_percent.get(), 70);
        assert!(!settings.ai.enabled);
        assert!(!settings.voice.cloud_speech_enabled);
        assert!(settings.ai.credential_id.is_none());
        assert!(settings.notifications.task_completed_sound);
        assert!(settings.notifications.task_created_sound);
        assert!(settings.notifications.task_deleted_sound);
        assert!(settings.notifications.reminder_sound);
        let approaching = settings
            .planning
            .nudge_rules
            .iter()
            .find(|rule| rule.kind == NudgeRuleKind::ApproachingDeadline)
            .expect("approaching_deadline rule");
        assert!(approaching.threshold.is_none());
        let stale = settings
            .planning
            .nudge_rules
            .iter()
            .find(|rule| rule.kind == NudgeRuleKind::StaleTask)
            .expect("stale_task rule");
        assert_eq!(stale.threshold, Some(14));
        // Selectable non-default options remain available.
        assert_eq!(Theme::System.as_str(), "system");
        assert_eq!(Density::Default.as_str(), "default");
        assert_eq!(DateFormat::Relative.as_str(), "relative");
        assert_eq!(TimeFormat::H12.as_str(), "h12");
        assert_eq!(
            settings.keyboard_shortcuts.len(),
            KEYBOARD_SHORTCUT_ACTIONS.len()
        );
        settings.validate().unwrap();
    }

    #[test]
    fn rejects_volume_percent_out_of_range() {
        assert!(matches!(
            VolumePercent::new(101),
            Err(ValidationError::OutOfRange {
                field: "volume_percent",
                ..
            })
        ));
        let mut settings = AppSettings::default_settings();
        settings.notifications.volume_percent = VolumePercent(150);
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::OutOfRange {
                field: "volume_percent",
                ..
            })
        ));
    }

    #[test]
    fn rejects_threshold_on_non_stale_nudge_rules() {
        let mut settings = AppSettings::default_settings();
        settings.planning.nudge_rules = vec![NudgeRuleSettings::new(
            NudgeRuleKind::ApproachingDeadline,
            true,
            Some(3),
        )];
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Invalid {
                field: "nudge_rules.threshold",
                ..
            })
        ));
    }

    #[test]
    fn rejects_capacity_out_of_range() {
        let mut settings = AppSettings::default_settings();
        settings.planning.capacity_minutes = 30;
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::OutOfRange {
                field: "capacity_minutes",
                ..
            })
        ));
        settings.planning.capacity_minutes = 2000;
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::OutOfRange {
                field: "capacity_minutes",
                ..
            })
        ));
    }

    #[test]
    fn rejects_work_hours_with_end_before_start() {
        let mut settings = AppSettings::default_settings();
        settings.planning.work_hours = Some(WorkHours {
            start_minute: 600,
            end_minute: 500,
        });
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Invalid {
                field: "work_hours",
                ..
            })
        ));
    }

    #[test]
    fn rejects_duplicate_nudge_rule_kinds() {
        let mut settings = AppSettings::default_settings();
        settings.planning.nudge_rules = vec![
            NudgeRuleSettings::new(NudgeRuleKind::Overdue, true, None),
            NudgeRuleSettings::new(NudgeRuleKind::Overdue, false, None),
        ];
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Duplicate {
                field: "nudge_rules"
            })
        ));
    }

    #[test]
    fn shortcuts_reject_unknown_and_duplicate_actions() {
        assert!(matches!(
            KeyboardShortcut::new("open_tab", "cmd+k"),
            Err(ValidationError::Invalid {
                field: "keyboard_shortcut.action",
                ..
            })
        ));

        let mut settings = AppSettings::default_settings();
        settings.keyboard_shortcuts = vec![
            KeyboardShortcut::new("quick_add", "cmd+a").unwrap(),
            KeyboardShortcut::new("quick-add", "cmd+k").unwrap(),
        ];
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Duplicate {
                field: "keyboard_shortcuts.action"
            })
        ));
    }

    #[test]
    fn shortcuts_reject_duplicate_reserved_malformed_and_prefix_ambiguous_bindings() {
        let mut settings = AppSettings::default_settings();
        settings.keyboard_shortcuts = vec![
            KeyboardShortcut::new("quick-add", "Control + K").unwrap(),
            KeyboardShortcut::new("search", "cmd+k").unwrap(),
        ];
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Duplicate {
                field: "keyboard_shortcuts.chord"
            })
        ));

        assert!(matches!(
            KeyboardShortcut::new("new-project", "Control+Shift+N"),
            Err(ValidationError::Invalid {
                field: "keyboard_shortcut.chord",
                ..
            })
        ));
        assert!(matches!(
            KeyboardShortcut::new("search", "cmd++k"),
            Err(ValidationError::InvalidFormat {
                field: "keyboard_shortcut.chord",
                ..
            })
        ));

        settings.keyboard_shortcuts = vec![
            KeyboardShortcut::new("search", "g").unwrap(),
            KeyboardShortcut::new("today", "g t").unwrap(),
        ];
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Invalid {
                field: "keyboard_shortcuts.chord",
                ..
            })
        ));
    }

    #[test]
    fn shortcuts_allow_shared_multi_key_prefixes_and_canonicalize_input() {
        let shortcuts = vec![
            KeyboardShortcut::new("today", "G T").unwrap(),
            KeyboardShortcut::new("cancelled", "g x").unwrap(),
        ];
        assert_eq!(shortcuts[0].chord, "g t");
        assert_eq!(shortcuts[1].action, "cancelled");
        validate_keyboard_shortcuts(&shortcuts).unwrap();
    }

    #[test]
    fn rejects_empty_notification_channels() {
        // Construct via JSON so we can bypass ReminderChannelSet::new.
        let json = r##"{
            "appearance":{"theme":"light","accent":"#3b82f6","density":"comfortable","font_size":"medium","font_family":"outfit","reduced_motion":false},
            "date_time":{"week_start":"sunday","calendar_default":"week","date_format":"short","time_format":"h24"},
            "task_defaults":{"default_view":"today","confirm_before_delete":true},
            "notifications":{"channels":{"channels":[]},"sound_enabled":true,"volume_percent":70,"task_completed_sound":true,"task_created_sound":true,"task_deleted_sound":true,"reminder_sound":true},
            "features":{"nudges_enabled":true,"eat_the_frog_enabled":false,"task_jar_enabled":false,"focus_mode_enabled":false,"daily_planning_enabled":true,"weekly_review_enabled":true},
            "planning":{"capacity_minutes":480,"nudge_rules":[]},
            "keyboard_shortcuts":[]
        }"##;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::Empty {
                field: "notification_channels"
            })
        ));
    }

    #[test]
    fn patch_replaces_only_provided_sections() {
        let base = AppSettings::default_settings();
        let patch = SettingsPatch {
            features: Some(FeatureSettings {
                nudges_enabled: false,
                eat_the_frog_enabled: true,
                task_jar_enabled: true,
                focus_mode_enabled: false,
                daily_planning_enabled: true,
                weekly_review_enabled: true,
            }),
            planning: Some(PlanningSettings {
                capacity_minutes: 240,
                work_hours: Some(WorkHours::new(9 * 60, 17 * 60).unwrap()),
                nudge_rules: default_nudge_rules(),
            }),
            ..SettingsPatch::default()
        };
        let next = base.apply_patch(&patch).unwrap();
        assert!(!next.features.nudges_enabled);
        assert!(next.features.eat_the_frog_enabled);
        assert_eq!(next.planning.capacity_minutes, 240);
        assert_eq!(next.appearance.theme, Theme::Light);
        assert_eq!(next.date_time.week_start, WeekStart::Sunday);
    }

    #[test]
    fn patch_with_reserved_chord_is_rejected() {
        let base = AppSettings::default_settings();
        let patch = SettingsPatch {
            keyboard_shortcuts: Some(vec![KeyboardShortcut {
                action: "new-project".into(),
                chord: "f5".into(),
            }]),
            ..SettingsPatch::default()
        };
        assert!(patch.validate().is_err());
        assert!(base.apply_patch(&patch).is_err());
    }

    #[test]
    fn theme_and_font_family_parse_round_trip() {
        assert_eq!(Theme::parse("system").unwrap(), Theme::System);
        assert_eq!(Theme::parse("nord").unwrap(), Theme::Nord);
        assert!(Theme::parse("solarized").is_err());
        assert_eq!(FontFamily::parse("inter").unwrap().as_str(), "inter");
        assert_eq!(
            ReminderChannel::InApp.as_str(),
            NotificationSettings::default_settings()
                .unwrap()
                .channels
                .as_slice()[0]
                .as_str()
        );
    }

    #[test]
    fn malformed_hex_accent_is_rejected_after_deserialization() {
        let mut json = serde_json::to_value(AppSettings::default_settings()).unwrap();
        json["appearance"]["accent"] = serde_json::Value::String("blue".into());
        let settings: AppSettings = serde_json::from_value(json).unwrap();
        assert!(matches!(
            settings.validate(),
            Err(ValidationError::InvalidFormat {
                field: "accent",
                ..
            })
        ));
    }

    #[test]
    fn normalize_chord_collapses_modifier_aliases() {
        assert_eq!(normalize_chord("Control + Shift + T"), "cmd+shift+t");
        assert_eq!(normalize_chord("CTRL+k"), "cmd+k");
        assert!(is_reserved_browser_chord("Control+Shift+N"));
        assert!(!is_reserved_browser_chord("Ctrl+K"));
    }
}
