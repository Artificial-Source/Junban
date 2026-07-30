//! Reminder intent and delivery value types.
//!
//! Task schedule intent lives on `Task.remind_at`. Occurrence rows, leases, and claims
//! are control-plane state owned by app/storage. These types only bound the durable
//! codes, claim/lease limits, and occurrence snapshots that later layers persist.

use std::time::Duration;

use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use crate::{TaskId, ValidationError};

/// Default rows returned by one reminder claim.
pub const DEFAULT_REMINDER_CLAIM_LIMIT: u32 = 20;
/// Hard ceiling for one reminder claim batch.
pub const MAX_REMINDER_CLAIM_LIMIT: u32 = 100;
/// Default owner lease / claim TTL (seconds).
pub const DEFAULT_REMINDER_LEASE_SECS: u64 = 90;
/// Hard ceiling for lease and claim TTLs accepted from callers.
pub const MAX_REMINDER_LEASE_SECS: u64 = 300;
/// Default claim batch size matches the frozen coordinator default.
pub const DEFAULT_REMINDER_CLAIM_SECS: u64 = 90;
/// Initial failure backoff.
pub const REMINDER_FAILURE_BACKOFF_START_SECS: u64 = 30;
/// Failure backoff ceiling (one hour).
pub const REMINDER_FAILURE_BACKOFF_MAX_SECS: u64 = 60 * 60;
/// Hard ceiling for one owner-lost sweep.
pub const MAX_OWNER_LOST_MARK_LIMIT: u32 = 100;
/// Terminal reminder audit retention window.
pub const REMINDER_TERMINAL_RETENTION_DAYS: i64 = 90;
/// Maximum retained terminal reminder audit rows (non-protected).
pub const REMINDER_TERMINAL_MAX_ROWS: usize = 2_000;
/// Maximum retained serialized terminal reminder audit material.
pub const REMINDER_TERMINAL_MAX_BYTES: usize = 2 * 1024 * 1024;

/// Allowlisted delivery channels. Arbitrary external channel names are rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderChannel {
    InApp,
    WebNotification,
    Sound,
    /// Desktop/native path (Phase 8). Stored in schema v3 allowlist now.
    Native,
}

impl ReminderChannel {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "in_app" => Ok(Self::InApp),
            "web_notification" => Ok(Self::WebNotification),
            "sound" => Ok(Self::Sound),
            "native" => Ok(Self::Native),
            _ => Err(ValidationError::InvalidFormat {
                field: "reminder_channel",
                expected: "in_app|web_notification|sound|native",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InApp => "in_app",
            Self::WebNotification => "web_notification",
            Self::Sound => "sound",
            Self::Native => "native",
        }
    }
}

/// Durable occurrence lifecycle. Terminal states are never compacted while current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderOccurrenceState {
    Pending,
    Claimed,
    Delivered,
    Failed,
    Cancelled,
}

impl ReminderOccurrenceState {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "pending" => Ok(Self::Pending),
            "claimed" => Ok(Self::Claimed),
            "delivered" => Ok(Self::Delivered),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(ValidationError::InvalidFormat {
                field: "reminder_occurrence_state",
                expected: "pending|claimed|delivered|failed|cancelled",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Delivered => "delivered",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Delivered | Self::Failed | Self::Cancelled)
    }
}

/// Bounded failure codes only—never free-form external diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderFailureCode {
    PermissionDenied,
    TemporarilyUnavailable,
    ChannelFailed,
    OwnerLost,
}

impl ReminderFailureCode {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "permission_denied" => Ok(Self::PermissionDenied),
            "temporarily_unavailable" => Ok(Self::TemporarilyUnavailable),
            "channel_failed" => Ok(Self::ChannelFailed),
            "owner_lost" => Ok(Self::OwnerLost),
            _ => Err(ValidationError::InvalidFormat {
                field: "reminder_failure_code",
                expected: "permission_denied|temporarily_unavailable|channel_failed|owner_lost",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PermissionDenied => "permission_denied",
            Self::TemporarilyUnavailable => "temporarily_unavailable",
            Self::ChannelFailed => "channel_failed",
            Self::OwnerLost => "owner_lost",
        }
    }
}

/// Non-empty allowlisted channel set for reminder presentation defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderChannelSet {
    channels: Vec<ReminderChannel>,
}

impl ReminderChannelSet {
    pub fn new(channels: Vec<ReminderChannel>) -> Result<Self, ValidationError> {
        if channels.is_empty() {
            return Err(ValidationError::Empty {
                field: "reminder_channels",
            });
        }
        let mut seen = Vec::with_capacity(channels.len());
        for channel in &channels {
            if seen.contains(channel) {
                return Err(ValidationError::Duplicate {
                    field: "reminder_channels",
                });
            }
            seen.push(*channel);
        }
        Ok(Self { channels })
    }

    #[must_use]
    pub fn as_slice(&self) -> &[ReminderChannel] {
        &self.channels
    }
}

/// Optional lead time before due, in whole minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ReminderLeadMinutes(u32);

impl ReminderLeadMinutes {
    pub fn new(value: u32) -> Result<Self, ValidationError> {
        // Zero means "at due"; negative is unrepresentable in u32.
        Ok(Self(value))
    }

    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Phase 3 reminder defaults stored under temporal app settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderSettings {
    pub channels: ReminderChannelSet,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_lead_minutes: Option<ReminderLeadMinutes>,
}

impl ReminderSettings {
    pub fn new(
        channels: ReminderChannelSet,
        default_lead_minutes: Option<ReminderLeadMinutes>,
    ) -> Self {
        Self {
            channels,
            default_lead_minutes,
        }
    }
}

/// Validate a claim batch size against the frozen default/max bounds.
pub fn validate_reminder_claim_limit(limit: u32) -> Result<u32, ValidationError> {
    if limit == 0 {
        return Err(ValidationError::TooSmall {
            field: "reminder_claim_limit",
            min: 1,
        });
    }
    if limit > MAX_REMINDER_CLAIM_LIMIT {
        return Err(ValidationError::OutOfRange {
            field: "reminder_claim_limit",
            min: 1,
            max: i64::from(MAX_REMINDER_CLAIM_LIMIT),
        });
    }
    Ok(limit)
}

/// Validate a positive bounded lease or claim TTL in seconds.
pub fn validate_reminder_lease_secs(secs: u64) -> Result<u64, ValidationError> {
    if secs == 0 {
        return Err(ValidationError::TooSmall {
            field: "reminder_lease_secs",
            min: 1,
        });
    }
    if secs > MAX_REMINDER_LEASE_SECS {
        return Err(ValidationError::OutOfRange {
            field: "reminder_lease_secs",
            min: 1,
            max: i64::try_from(MAX_REMINDER_LEASE_SECS).unwrap_or(i64::MAX),
        });
    }
    Ok(secs)
}

/// Validate a positive bounded owner-lost sweep size.
pub fn validate_owner_lost_mark_limit(limit: u32) -> Result<u32, ValidationError> {
    if limit == 0 {
        return Err(ValidationError::TooSmall {
            field: "owner_lost_mark_limit",
            min: 1,
        });
    }
    if limit > MAX_OWNER_LOST_MARK_LIMIT {
        return Err(ValidationError::OutOfRange {
            field: "owner_lost_mark_limit",
            min: 1,
            max: i64::from(MAX_OWNER_LOST_MARK_LIMIT),
        });
    }
    Ok(limit)
}

/// Exponential-ish failure backoff: 30s, 60s, 120s… capped at one hour.
///
/// `attempt` is the 1-based failure count after the attempt that just failed.
#[must_use]
pub fn reminder_failure_backoff(attempt: u32) -> Duration {
    if attempt == 0 {
        return Duration::from_secs(REMINDER_FAILURE_BACKOFF_START_SECS);
    }
    let shift = u32::min(attempt.saturating_sub(1), 16);
    let secs = REMINDER_FAILURE_BACKOFF_START_SECS.saturating_mul(1u64 << shift);
    Duration::from_secs(secs.min(REMINDER_FAILURE_BACKOFF_MAX_SECS))
}

/// Opaque fencing term issued by the delivery lease owner.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ReminderFenceTerm(String);

impl ReminderFenceTerm {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        if value.is_empty() || value.len() > 128 {
            return Err(ValidationError::InvalidFormat {
                field: "reminder_fence_term",
                expected: "non-empty opaque term at most 128 chars",
            });
        }
        if value.chars().any(|ch| ch.is_control()) {
            return Err(ValidationError::InvalidFormat {
                field: "reminder_fence_term",
                expected: "non-control opaque term",
            });
        }
        Ok(Self(value.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ReminderFenceTerm {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Durable occurrence row keyed by `(task_id, remind_at)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderOccurrence {
    pub task_id: TaskId,
    pub remind_at: Timestamp,
    pub state: ReminderOccurrenceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_term: Option<ReminderFenceTerm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_expires_at: Option<Timestamp>,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_attempt_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_channel: Option<ReminderChannel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_error_code: Option<ReminderFailureCode>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl ReminderOccurrence {
    /// Stable receipt/post-image map key for one occurrence identity.
    #[must_use]
    pub fn map_key(&self) -> String {
        reminder_occurrence_key(self.task_id, self.remind_at)
    }
}

/// Fixed-width UTC text for every reminder comparison/ordering column.
///
/// Jiff's default `Display` omits trailing fractional zeros, so variable-width
/// RFC3339 text is not lexicographically ordered (whole seconds sort after any
/// fractional second). Nine fractional digits preserve nanosecond precision and
/// keep SQL text comparisons aligned with instant order.
#[must_use]
pub fn format_reminder_timestamp(ts: Timestamp) -> String {
    format!("{ts:.9}")
}

/// Build the durable map key for one `(task_id, remind_at)` identity.
#[must_use]
pub fn reminder_occurrence_key(task_id: TaskId, remind_at: Timestamp) -> String {
    format!("{task_id}/{}", format_reminder_timestamp(remind_at))
}

/// One global delivery-owner lease snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderDeliveryLease {
    pub fence_term: ReminderFenceTerm,
    pub expires_at: Timestamp,
    pub updated_at: Timestamp,
}

/// One claimed due occurrence returned to a lease owner.
///
/// `claim_attempt` is the durable `attempts` value after the successful claim
/// UPDATE. Settlement must present this exact generation so a delayed callback
/// cannot finish a newer claim that reused the same fence term.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimedReminder {
    pub task_id: TaskId,
    pub remind_at: Timestamp,
    pub claim_term: ReminderFenceTerm,
    pub claim_expires_at: Timestamp,
    pub claim_attempt: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_and_failure_codes_are_allowlisted() {
        assert_eq!(
            ReminderChannel::parse("in_app").unwrap(),
            ReminderChannel::InApp
        );
        assert!(ReminderChannel::parse("email").is_err());
        assert_eq!(
            ReminderFailureCode::parse("owner_lost").unwrap(),
            ReminderFailureCode::OwnerLost
        );
        assert!(ReminderFailureCode::parse("boom").is_err());
        assert!(ReminderOccurrenceState::Delivered.is_terminal());
        assert!(!ReminderOccurrenceState::Pending.is_terminal());
    }

    #[test]
    fn channel_set_rejects_empty_and_duplicates() {
        assert!(ReminderChannelSet::new(vec![]).is_err());
        assert!(
            ReminderChannelSet::new(vec![ReminderChannel::InApp, ReminderChannel::InApp]).is_err()
        );
        assert!(
            ReminderChannelSet::new(vec![ReminderChannel::InApp, ReminderChannel::Sound]).is_ok()
        );
    }

    #[test]
    fn claim_limit_and_backoff_bounds() {
        assert_eq!(
            validate_reminder_claim_limit(DEFAULT_REMINDER_CLAIM_LIMIT).unwrap(),
            20
        );
        assert!(validate_reminder_claim_limit(0).is_err());
        assert!(validate_reminder_claim_limit(MAX_REMINDER_CLAIM_LIMIT + 1).is_err());
        assert_eq!(
            validate_reminder_lease_secs(DEFAULT_REMINDER_LEASE_SECS).unwrap(),
            90
        );
        assert!(validate_reminder_lease_secs(0).is_err());
        assert!(validate_reminder_lease_secs(MAX_REMINDER_LEASE_SECS + 1).is_err());
        assert!(validate_owner_lost_mark_limit(0).is_err());
        assert!(validate_owner_lost_mark_limit(MAX_OWNER_LOST_MARK_LIMIT + 1).is_err());
        assert_eq!(
            reminder_failure_backoff(1).as_secs(),
            REMINDER_FAILURE_BACKOFF_START_SECS
        );
        assert_eq!(reminder_failure_backoff(2).as_secs(), 60);
        assert_eq!(
            reminder_failure_backoff(20).as_secs(),
            REMINDER_FAILURE_BACKOFF_MAX_SECS
        );
        assert!(ReminderFenceTerm::parse("").is_err());
        assert_eq!(
            ReminderChannel::parse("native").unwrap(),
            ReminderChannel::Native
        );
    }

    #[test]
    fn reminder_timestamp_text_is_fixed_width_and_sortable() {
        let whole: Timestamp = "2026-07-28T15:00:00Z".parse().unwrap();
        let frac_low: Timestamp = "2026-07-28T15:00:00.1Z".parse().unwrap();
        let frac_high: Timestamp = "2026-07-28T15:00:00.5Z".parse().unwrap();
        let whole_text = format_reminder_timestamp(whole);
        let low_text = format_reminder_timestamp(frac_low);
        let high_text = format_reminder_timestamp(frac_high);
        assert_eq!(whole_text, "2026-07-28T15:00:00.000000000Z");
        assert_eq!(low_text, "2026-07-28T15:00:00.100000000Z");
        assert_eq!(high_text, "2026-07-28T15:00:00.500000000Z");
        // Default Display is not ordered; canonical text is.
        assert!(whole.to_string() > frac_low.to_string());
        assert!(whole_text.as_str() < low_text.as_str());
        assert!(low_text.as_str() < high_text.as_str());
        assert_eq!(
            reminder_occurrence_key(
                TaskId::parse("01900000-0000-7000-8000-000000000001").unwrap(),
                whole
            ),
            "01900000-0000-7000-8000-000000000001/2026-07-28T15:00:00.000000000Z"
        );
    }
}
