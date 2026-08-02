//! Run identity and generation-fence cancellation contract.
//!
//! Dropping or cancelling the provider future is the transport cancellation
//! mechanism. The local generation fence is authoritative for whether late
//! transcript, tool, persistence, or audio effects may apply.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Unguessable identifier for one provider run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RunId(Uuid);

impl RunId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    /// Adopt a durable run UUID already assigned by the domain/application layer.
    ///
    /// Provider cancellation must reuse this identity rather than minting a second one.
    #[must_use]
    pub const fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl Default for RunId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for RunId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Monotonic generation counter associated with a run or call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Generation(u64);

impl Generation {
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for Generation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Monotonically replaced generation fence for one logical run or call.
#[derive(Debug)]
pub struct GenerationFence {
    current: AtomicU64,
}

impl GenerationFence {
    #[must_use]
    pub fn new() -> Self {
        Self::at(Generation::new(1))
    }

    /// Fence whose current authoritative generation is exactly `generation`.
    #[must_use]
    pub fn at(generation: Generation) -> Self {
        Self {
            current: AtomicU64::new(generation.get()),
        }
    }

    #[must_use]
    pub fn current(&self) -> Generation {
        Generation(self.current.load(Ordering::SeqCst))
    }

    /// Invalidate the current generation and return the new authoritative value.
    pub fn revoke(&self) -> Generation {
        let next = self
            .current
            .fetch_add(1, Ordering::SeqCst)
            .saturating_add(1);
        Generation(next)
    }

    #[must_use]
    pub fn is_current(&self, generation: Generation) -> bool {
        self.current.load(Ordering::SeqCst) == generation.get()
    }
}

impl Default for GenerationFence {
    fn default() -> Self {
        Self::new()
    }
}

/// Combined run identity, generation fence, and cooperative cancel token.
#[derive(Debug, Clone)]
pub struct RunCancel {
    run_id: RunId,
    fence: std::sync::Arc<GenerationFence>,
    token: CancellationToken,
    generation: Generation,
}

impl RunCancel {
    #[must_use]
    pub fn new() -> Self {
        let fence = std::sync::Arc::new(GenerationFence::new());
        let generation = fence.current();
        Self {
            run_id: RunId::new(),
            fence,
            token: CancellationToken::new(),
            generation,
        }
    }

    /// Build cancellation state for an already-assigned durable run identity.
    ///
    /// The handle carries exactly `run_id` and starts at `generation` so later
    /// provider work, persistence fences, and server registry entries share one
    /// identity rather than minting a second UUID.
    #[must_use]
    pub fn for_identity(run_id: RunId, generation: Generation) -> Self {
        let fence = std::sync::Arc::new(GenerationFence::at(generation));
        Self {
            run_id,
            fence,
            token: CancellationToken::new(),
            generation,
        }
    }

    #[must_use]
    pub fn run_id(&self) -> RunId {
        self.run_id
    }

    #[must_use]
    pub fn generation(&self) -> Generation {
        self.generation
    }

    #[must_use]
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// True while this handle's generation is still authoritative and not cancelled.
    #[must_use]
    pub fn is_live(&self) -> bool {
        !self.token.is_cancelled() && self.fence.is_current(self.generation)
    }

    /// Revoke the generation and cancel in-flight provider work.
    pub fn cancel(&self) {
        self.fence.revoke();
        self.token.cancel();
    }

    /// Return [`ProviderError::Cancelled`] when this handle is no longer live.
    pub fn check_live(&self) -> Result<(), crate::error::ProviderError> {
        if self.is_live() {
            Ok(())
        } else {
            Err(crate::error::ProviderError::Cancelled)
        }
    }
}

impl Default for RunCancel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_revokes_generation_and_token() {
        let run = RunCancel::new();
        let generation = run.generation();
        assert!(run.is_live());
        run.cancel();
        assert!(!run.is_live());
        assert!(!run.fence.is_current(generation));
        assert!(run.token().is_cancelled());
        assert!(matches!(
            run.check_live(),
            Err(crate::error::ProviderError::Cancelled)
        ));
    }

    #[test]
    fn for_identity_preserves_exact_uuid_and_starting_generation() {
        let uuid = Uuid::now_v7();
        let run_id = RunId::from_uuid(uuid);
        let generation = Generation::new(7);
        let run = RunCancel::for_identity(run_id, generation);
        assert_eq!(run.run_id().as_uuid(), uuid);
        assert_eq!(run.generation(), generation);
        assert!(run.is_live());
        run.cancel();
        assert!(!run.is_live());
        assert!(!run.fence.is_current(generation));
    }
}
