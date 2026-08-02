//! Bounded normalized provider stream events.
//!
//! These are adapter-output events. Browser/server SSE DTOs are composed later
//! and must not forward raw vendor frames by default.

use serde::{Deserialize, Serialize};

/// Provider-neutral stream event after adapter normalization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedStreamEvent {
    /// Incremental assistant text.
    TextDelta { text: String },
    /// Non-content status label only; never carries hidden chain-of-thought.
    ReasoningStatus { label: String },
    /// Optional usage totals when the provider emits them.
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    /// Provider stream reached a normal terminal state (`[DONE]` or equivalent).
    Completed,
}
