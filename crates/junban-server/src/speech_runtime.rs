//! Independent cloud-speech lifecycle authority.
//!
//! Speech activity is not represented as a fake AI run. This supervisor owns
//! separate admission, cancellation, draining, and lazy runtime destruction,
//! while server reconfiguration coordinates its epochs with the AI supervisor.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use junban_ai::{
    ProviderError, SpeechCredential, SpeechRuntime, SynthesisRequest, SynthesisResult,
    TranscriptionRequest, TranscriptionResult,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub const MAX_ACTIVE_CLOUD_SPEECH: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechActivityKind {
    Transcription,
    Synthesis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechRuntimeError {
    NotRunning,
    Capacity,
    InvalidEpoch,
    NotDrained,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lifecycle {
    Running { epoch: u64 },
    Reconfiguring { epoch: u64, runtime_dropped: bool },
    DrainingPermanent { epoch: u64 },
}

struct ActiveActivity {
    cancel: CancellationToken,
}

struct Inner {
    lifecycle: Lifecycle,
    next_activity: u64,
    runtime: Option<Arc<SpeechRuntime>>,
    active: HashMap<u64, ActiveActivity>,
}

pub struct SpeechActivitySupervisor {
    inner: Mutex<Inner>,
    drained: Notify,
}

impl std::fmt::Debug for SpeechActivitySupervisor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().expect("speech runtime lock");
        formatter
            .debug_struct("SpeechActivitySupervisor")
            .field("lifecycle", &inner.lifecycle)
            .field("active", &inner.active.len())
            .field("runtime_constructed", &inner.runtime.is_some())
            .finish()
    }
}

impl Default for SpeechActivitySupervisor {
    fn default() -> Self {
        Self::new()
    }
}

impl SpeechActivitySupervisor {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                lifecycle: Lifecycle::Running { epoch: 1 },
                next_activity: 1,
                runtime: None,
                active: HashMap::new(),
            }),
            drained: Notify::new(),
        }
    }

    pub fn admit(
        self: &Arc<Self>,
        kind: SpeechActivityKind,
    ) -> Result<SpeechActivityGuard, SpeechRuntimeError> {
        let mut inner = self.inner.lock().expect("speech runtime lock");
        if !matches!(inner.lifecycle, Lifecycle::Running { .. }) {
            return Err(SpeechRuntimeError::NotRunning);
        }
        if inner.active.len() >= MAX_ACTIVE_CLOUD_SPEECH {
            return Err(SpeechRuntimeError::Capacity);
        }
        let activity_id = inner.next_activity;
        inner.next_activity = inner.next_activity.wrapping_add(1).max(1);
        let cancel = CancellationToken::new();
        let runtime = Arc::clone(
            inner
                .runtime
                .get_or_insert_with(|| Arc::new(SpeechRuntime::new())),
        );
        inner.active.insert(
            activity_id,
            ActiveActivity {
                cancel: cancel.clone(),
            },
        );
        Ok(SpeechActivityGuard {
            supervisor: Arc::downgrade(self),
            activity_id,
            kind,
            runtime,
            cancel,
            released: false,
        })
    }

    pub fn begin_reconfigure(&self) -> Result<u64, SpeechRuntimeError> {
        let mut inner = self.inner.lock().expect("speech runtime lock");
        let Lifecycle::Running { epoch } = inner.lifecycle else {
            return Err(SpeechRuntimeError::NotRunning);
        };
        let epoch = epoch.wrapping_add(1).max(1);
        inner.lifecycle = Lifecycle::Reconfiguring {
            epoch,
            runtime_dropped: false,
        };
        for activity in inner.active.values() {
            activity.cancel.cancel();
        }
        Ok(epoch)
    }

    pub async fn wait_drained(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.drained.notified();
            if self
                .inner
                .lock()
                .expect("speech runtime lock")
                .active
                .is_empty()
            {
                return true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    pub fn drop_reconfigure_runtime(&self, epoch: u64) -> Result<(), SpeechRuntimeError> {
        let mut inner = self.inner.lock().expect("speech runtime lock");
        if inner.lifecycle
            != (Lifecycle::Reconfiguring {
                epoch,
                runtime_dropped: false,
            })
        {
            return Err(SpeechRuntimeError::InvalidEpoch);
        }
        if !inner.active.is_empty() {
            return Err(SpeechRuntimeError::NotDrained);
        }
        inner.runtime = None;
        inner.lifecycle = Lifecycle::Reconfiguring {
            epoch,
            runtime_dropped: true,
        };
        Ok(())
    }

    pub fn validate_finish_reconfigure(&self, epoch: u64) -> Result<(), SpeechRuntimeError> {
        let inner = self.inner.lock().expect("speech runtime lock");
        if inner.lifecycle
            != (Lifecycle::Reconfiguring {
                epoch,
                runtime_dropped: true,
            })
            || inner.runtime.is_some()
            || !inner.active.is_empty()
        {
            return Err(SpeechRuntimeError::InvalidEpoch);
        }
        Ok(())
    }

    pub fn finish_reconfigure(&self, epoch: u64) -> Result<(), SpeechRuntimeError> {
        self.validate_finish_reconfigure(epoch)?;
        let mut inner = self.inner.lock().expect("speech runtime lock");
        if inner.lifecycle
            != (Lifecycle::Reconfiguring {
                epoch,
                runtime_dropped: true,
            })
            || inner.runtime.is_some()
            || !inner.active.is_empty()
        {
            return Err(SpeechRuntimeError::InvalidEpoch);
        }
        inner.lifecycle = Lifecycle::Running { epoch };
        Ok(())
    }

    /// Revoke admission permanently and cancel all in-flight provider work.
    pub fn begin_permanent_drain(&self) {
        let mut inner = self.inner.lock().expect("speech runtime lock");
        let epoch = match inner.lifecycle {
            Lifecycle::Running { epoch }
            | Lifecycle::Reconfiguring { epoch, .. }
            | Lifecycle::DrainingPermanent { epoch } => epoch.wrapping_add(1).max(1),
        };
        inner.lifecycle = Lifecycle::DrainingPermanent { epoch };
        for activity in inner.active.values() {
            activity.cancel.cancel();
        }
    }

    pub fn drop_permanent_runtime(&self) -> Result<(), SpeechRuntimeError> {
        let mut inner = self.inner.lock().expect("speech runtime lock");
        if !matches!(inner.lifecycle, Lifecycle::DrainingPermanent { .. }) {
            return Err(SpeechRuntimeError::NotRunning);
        }
        if !inner.active.is_empty() {
            return Err(SpeechRuntimeError::NotDrained);
        }
        inner.runtime = None;
        Ok(())
    }

    #[must_use]
    pub fn provider_client_construct_calls(&self) -> usize {
        self.inner
            .lock()
            .expect("speech runtime lock")
            .runtime
            .as_ref()
            .map_or(0, |runtime| runtime.factory().construct_calls())
    }

    #[cfg(test)]
    pub fn active_count(&self) -> usize {
        self.inner.lock().expect("speech runtime lock").active.len()
    }

    #[cfg(test)]
    pub fn runtime_constructed(&self) -> bool {
        self.inner
            .lock()
            .expect("speech runtime lock")
            .runtime
            .is_some()
    }

    fn release(&self, activity_id: u64) {
        let removed = self
            .inner
            .lock()
            .expect("speech runtime lock")
            .active
            .remove(&activity_id);
        if removed.is_some() {
            self.drained.notify_waiters();
        }
    }

    fn result_is_current(&self, activity_id: u64, cancel: &CancellationToken) -> bool {
        if cancel.is_cancelled() {
            return false;
        }
        let inner = self.inner.lock().expect("speech runtime lock");
        inner.active.contains_key(&activity_id)
            && !matches!(inner.lifecycle, Lifecycle::DrainingPermanent { .. })
    }
}

pub struct SpeechActivityGuard {
    supervisor: Weak<SpeechActivitySupervisor>,
    activity_id: u64,
    kind: SpeechActivityKind,
    runtime: Arc<SpeechRuntime>,
    cancel: CancellationToken,
    released: bool,
}

impl std::fmt::Debug for SpeechActivityGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpeechActivityGuard")
            .field("activity_id", &self.activity_id)
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

impl SpeechActivityGuard {
    pub async fn transcribe(
        &self,
        request: &TranscriptionRequest,
        credential: &SpeechCredential,
    ) -> Result<TranscriptionResult, ProviderError> {
        self.runtime
            .transcribe(request, credential, &self.cancel)
            .await
    }

    pub async fn synthesize(
        &self,
        request: &SynthesisRequest,
        credential: &SpeechCredential,
    ) -> Result<SynthesisResult, ProviderError> {
        self.runtime
            .synthesize(request, credential, &self.cancel)
            .await
    }

    /// Publish only while this exact activity remains live. This is the late
    /// result fence used after every provider await.
    pub fn commit_result<T>(&self, result: T) -> Option<T> {
        self.supervisor
            .upgrade()
            .filter(|supervisor| supervisor.result_is_current(self.activity_id, &self.cancel))
            .map(|_| result)
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    fn release(&mut self) {
        if self.released {
            return;
        }
        self.cancel.cancel();
        if let Some(supervisor) = self.supervisor.upgrade() {
            supervisor.release(self.activity_id);
        }
        self.released = true;
    }
}

impl Drop for SpeechActivityGuard {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[tokio::test]
    async fn reconfiguration_closes_admission_drains_and_recreates_lazily() {
        let supervisor = Arc::new(SpeechActivitySupervisor::new());
        assert!(!supervisor.runtime_constructed());
        let guard = supervisor.admit(SpeechActivityKind::Transcription).unwrap();
        assert!(supervisor.runtime_constructed());
        let epoch = supervisor.begin_reconfigure().unwrap();
        assert!(guard.cancellation_token().is_cancelled());
        assert!(matches!(
            supervisor.admit(SpeechActivityKind::Synthesis),
            Err(SpeechRuntimeError::NotRunning)
        ));
        assert!(!supervisor.wait_drained(Duration::ZERO).await);
        drop(guard);
        assert!(supervisor.wait_drained(Duration::ZERO).await);
        supervisor.drop_reconfigure_runtime(epoch).unwrap();
        assert!(!supervisor.runtime_constructed());
        supervisor.finish_reconfigure(epoch).unwrap();
        let fresh = supervisor.admit(SpeechActivityKind::Synthesis).unwrap();
        assert!(supervisor.runtime_constructed());
        drop(fresh);
    }

    #[tokio::test]
    async fn timed_out_drain_remains_fail_closed() {
        let supervisor = Arc::new(SpeechActivitySupervisor::new());
        let guard = supervisor.admit(SpeechActivityKind::Synthesis).unwrap();
        let epoch = supervisor.begin_reconfigure().unwrap();
        assert!(!supervisor.wait_drained(Duration::ZERO).await);
        assert!(supervisor.drop_reconfigure_runtime(epoch).is_err());
        assert!(matches!(
            supervisor.admit(SpeechActivityKind::Transcription),
            Err(SpeechRuntimeError::NotRunning)
        ));
        drop(guard);
    }

    #[tokio::test]
    async fn permanent_drain_cancels_stt_and_tts_and_suppresses_late_results() {
        let supervisor = Arc::new(SpeechActivitySupervisor::new());
        let stt = supervisor.admit(SpeechActivityKind::Transcription).unwrap();
        let tts = supervisor.admit(SpeechActivityKind::Synthesis).unwrap();
        let stt_cancel = stt.cancellation_token();
        let tts_cancel = tts.cancellation_token();
        supervisor.begin_permanent_drain();
        assert!(stt_cancel.is_cancelled());
        assert!(tts_cancel.is_cancelled());
        assert!(stt.commit_result("late transcription").is_none());
        assert!(tts.commit_result("late audio").is_none());
        drop(stt);
        drop(tts);
        assert!(supervisor.wait_drained(Duration::ZERO).await);
        supervisor.drop_permanent_runtime().unwrap();
    }

    #[test]
    fn disconnect_drop_cancels_exact_activity() {
        let supervisor = Arc::new(SpeechActivitySupervisor::new());
        let guard = supervisor.admit(SpeechActivityKind::Transcription).unwrap();
        let cancel = guard.cancellation_token();
        drop(guard);
        assert!(cancel.is_cancelled());
        assert_eq!(supervisor.active_count(), 0);
    }

    #[test]
    fn request_admission_and_reconfigure_linearize_under_one_lock() {
        for _ in 0..64 {
            let supervisor = Arc::new(SpeechActivitySupervisor::new());
            let barrier = Arc::new(Barrier::new(2));
            let admit_supervisor = Arc::clone(&supervisor);
            let begin_supervisor = Arc::clone(&supervisor);
            let admit_barrier = Arc::clone(&barrier);
            let begin_barrier = Arc::clone(&barrier);
            let admit = std::thread::spawn(move || {
                admit_barrier.wait();
                admit_supervisor.admit(SpeechActivityKind::Transcription)
            });
            let begin = std::thread::spawn(move || {
                begin_barrier.wait();
                begin_supervisor.begin_reconfigure()
            });
            let admitted = admit.join().unwrap();
            let epoch = begin.join().unwrap();
            match (admitted, epoch) {
                (Ok(guard), Ok(_)) => {
                    // Admission won, then the epoch cancelled it and suppressed a late result.
                    assert!(guard.commit_result(()).is_none());
                    drop(guard);
                }
                (Err(SpeechRuntimeError::NotRunning), Ok(_)) => {
                    // Epoch won, so no request was admitted after it.
                    assert_eq!(supervisor.active_count(), 0);
                }
                (admitted, epoch) => panic!("unexpected race outcome: {admitted:?} {epoch:?}"),
            }
            assert!(matches!(
                supervisor.admit(SpeechActivityKind::Synthesis),
                Err(SpeechRuntimeError::NotRunning)
            ));
        }
    }

    #[test]
    fn capacity_is_bounded() {
        let supervisor = Arc::new(SpeechActivitySupervisor::new());
        let guards: Vec<_> = (0..MAX_ACTIVE_CLOUD_SPEECH)
            .map(|_| supervisor.admit(SpeechActivityKind::Synthesis).unwrap())
            .collect();
        assert!(matches!(
            supervisor.admit(SpeechActivityKind::Synthesis),
            Err(SpeechRuntimeError::Capacity)
        ));
        drop(guards);
    }
}
