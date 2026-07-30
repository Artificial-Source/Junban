//! Reminder intent and delivery value types.
//!
//! Coordination (leases, claims) stays control-plane in app/storage. These types only
//! bound the durable codes and settings that later layers persist.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::ValidationError;

/// Default rows returned by one reminder claim.
pub const DEFAULT_REMINDER_CLAIM_LIMIT: u32 = 20;
/// Hard ceiling for one reminder claim batch.
pub const MAX_REMINDER_CLAIM_LIMIT: u32 = 100;
/// Initial failure backoff.
pub const REMINDER_FAILURE_BACKOFF_START_SECS: u64 = 30;
/// Failure backoff ceiling (one hour).
pub const REMINDER_FAILURE_BACKOFF_MAX_SECS: u64 = 60 * 60;

/// Allowlisted delivery channels. Arbitrary external channel names are rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderChannel {
    InApp,
    WebNotification,
    Sound,
}

impl ReminderChannel {
    pub fn parse(value: &str) -> Result<Self, ValidationError> {
        match value {
            "in_app" => Ok(Self::InApp),
            "web_notification" => Ok(Self::WebNotification),
            "sound" => Ok(Self::Sound),
            _ => Err(ValidationError::InvalidFormat {
                field: "reminder_channel",
                expected: "in_app|web_notification|sound",
            }),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InApp => "in_app",
            Self::WebNotification => "web_notification",
            Self::Sound => "sound",
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
            reminder_failure_backoff(1).as_secs(),
            REMINDER_FAILURE_BACKOFF_START_SECS
        );
        assert_eq!(reminder_failure_backoff(2).as_secs(), 60);
        assert_eq!(
            reminder_failure_backoff(20).as_secs(),
            REMINDER_FAILURE_BACKOFF_MAX_SECS
        );
    }
}
