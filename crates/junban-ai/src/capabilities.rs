//! Provider capability flags discovered or declared by configuration.
//!
//! Capabilities are positive statements of support. Unsupported actions fail as
//! unavailable rather than being guessed from a hard-coded model catalog.

use serde::{Deserialize, Serialize};

/// One discrete provider or model capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    /// Incremental token streaming over HTTP SSE.
    ChatStreaming,
    /// Non-streaming chat completion.
    ChatCompletion,
    /// Tool/function calling.
    Tools,
    /// Streaming plus tools in one request (absent for known incompatibilities).
    StreamingTools,
    /// Multimodal image inputs.
    Vision,
    /// Provider-reported reasoning/status without hidden chain-of-thought text.
    ReasoningStatus,
    /// Model listing/discovery endpoint.
    ModelDiscovery,
}

/// Bounded set of capabilities for one provider configuration or discovered model.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderCapabilities {
    capabilities: Vec<ProviderCapability>,
}

impl ProviderCapabilities {
    #[must_use]
    pub fn new(capabilities: impl IntoIterator<Item = ProviderCapability>) -> Self {
        let mut capabilities: Vec<_> = capabilities.into_iter().collect();
        capabilities.sort_by_key(|capability| capability_ord(*capability));
        capabilities.dedup();
        Self { capabilities }
    }

    #[must_use]
    pub fn contains(&self, capability: ProviderCapability) -> bool {
        self.capabilities.contains(&capability)
    }

    pub fn iter(&self) -> impl Iterator<Item = ProviderCapability> + '_ {
        self.capabilities.iter().copied()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.capabilities.is_empty()
    }
}

const fn capability_ord(capability: ProviderCapability) -> u8 {
    match capability {
        ProviderCapability::ChatStreaming => 0,
        ProviderCapability::ChatCompletion => 1,
        ProviderCapability::Tools => 2,
        ProviderCapability::StreamingTools => 3,
        ProviderCapability::Vision => 4,
        ProviderCapability::ReasoningStatus => 5,
        ProviderCapability::ModelDiscovery => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deduplicates_and_orders_capabilities() {
        let caps = ProviderCapabilities::new([
            ProviderCapability::Tools,
            ProviderCapability::ChatStreaming,
            ProviderCapability::Tools,
        ]);
        assert!(caps.contains(ProviderCapability::ChatStreaming));
        assert!(caps.contains(ProviderCapability::Tools));
        assert_eq!(caps.iter().count(), 2);
    }
}
