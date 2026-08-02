//! Bounded normalized provider stream events.
//!
//! These are adapter-output events. Browser/server SSE DTOs are composed later
//! and must not forward raw vendor frames by default. Raw vendor frames,
//! request IDs, chain-of-thought text, credentials, and vendor bodies never
//! appear here.

use serde::{Deserialize, Serialize};

/// Provider-neutral stream event after adapter normalization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedStreamEvent {
    /// Provider accepted the run and began producing output.
    RunStarted,
    /// Incremental assistant text.
    TextDelta { text: String },
    /// Non-content status label only; never carries hidden chain-of-thought.
    ReasoningStatus { label: String },
    /// Model proposed a tool/function call. Arguments are canonical JSON text.
    ToolProposed {
        call_id: String,
        name: String,
        arguments: String,
    },
    /// Provider-reported tool-result acknowledgement metadata (no large bodies).
    ToolResultMeta { call_id: String, ok: bool },
    /// Optional usage totals when the provider emits them.
    Usage {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    /// Provider stream reached a normal terminal state (`[DONE]` or equivalent).
    Completed,
    /// Provider reported a terminal failure after the stream began.
    Failed { message: String },
    /// Local generation fence cancelled the run.
    Cancelled,
}

impl NormalizedStreamEvent {
    /// True for terminal events that end a provider run.
    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed { .. } | Self::Cancelled
        )
    }
}
