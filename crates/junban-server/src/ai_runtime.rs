//! Lazy AI provider runtime supervisor for the normal profile owner.
//!
//! Construction allocates only registry and synchronization state. No
//! `reqwest::Client`, TLS pool, provider endpoint, credential load, background
//! task, or network I/O occurs until admitted work uses the runtime. Recovery
//! mode never constructs this type.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use junban_ai::{
    DiscoveredModel, Generation, NormalizedStreamEvent, ProviderChatRequest, ProviderEndpoint,
    ProviderError, ProviderRuntime, RunCancel, RunId,
};
use junban_domain::AiRunId;
use tokio::sync::Notify;

/// Hard concurrent ceiling for in-flight AI provider runs in one process.
pub const MAX_ACTIVE_AI_RUNS: usize = 4;

/// Stable AI runtime supervisor failures without run IDs or secret material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AiRuntimeError {
    /// Admission is closed (drain, restore, or shutdown).
    #[error("AI runtime is not accepting work")]
    NotAccepting,
    /// The hard concurrent run ceiling has been reached.
    #[error("AI concurrent run limit reached")]
    Capacity,
    /// The durable run identity is already registered.
    #[error("AI run is already registered")]
    Duplicate,
    /// Cancel targeted a run that is not active.
    #[error("AI run was not found")]
    NotFound,
    /// A drain or drop was requested while active work remains.
    #[error("AI runtime is still busy")]
    Busy,
    /// The requested transition is not valid in the current lifecycle state.
    #[error("AI runtime lifecycle does not permit this operation")]
    InvalidLifecycle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiRuntimeLifecycle {
    Accepting,
    Draining,
    Drained,
}

struct ActiveRun {
    generation: u64,
    cancel: Arc<RunCancel>,
}

struct AiRuntimeInner {
    lifecycle: AiRuntimeLifecycle,
    runtime: Option<Arc<ProviderRuntime>>,
    active: HashMap<AiRunId, ActiveRun>,
}

/// Process-local lazy AI runtime and live-run registry.
///
/// One mutex is the sole authority for admission, lazy runtime creation, and
/// lifecycle transitions. Provider work can only be reached through an admitted
/// [`AiRunGuard`]; there is intentionally no raw runtime accessor.
///
/// ```compile_fail
/// let supervisor = junban_server::AiRuntimeSupervisor::new();
/// let _raw_runtime = supervisor.runtime();
/// ```
pub struct AiRuntimeSupervisor {
    inner: Mutex<AiRuntimeInner>,
    drain_notify: Notify,
}

/// RAII authority for one admitted AI run generation.
///
/// The guard is intentionally not cloneable and exposes provider operations only
/// as methods borrowing `&self` for the complete provider future. Its runtime and
/// cancellation state remain private, so dropping the guard is the only way to
/// release its tracked authority.
///
/// ```compile_fail
/// let supervisor = junban_server::AiRuntimeSupervisor::new();
/// let guard = supervisor
///     .admit_run(junban_domain::AiRunId::new(), 1)
///     .unwrap();
/// let _escaped = guard.clone();
/// ```
///
/// ```compile_fail
/// let supervisor = junban_server::AiRuntimeSupervisor::new();
/// let guard = supervisor
///     .admit_run(junban_domain::AiRunId::new(), 1)
///     .unwrap();
/// let _raw_cancel = guard.cancel_handle();
/// ```
pub struct AiRunGuard {
    supervisor: Arc<AiRuntimeSupervisor>,
    run_id: AiRunId,
    generation: u64,
    runtime: Option<Arc<ProviderRuntime>>,
    cancel: Arc<RunCancel>,
}

impl AiRunGuard {
    /// Durable domain run identity for this admission.
    #[must_use]
    pub fn run_id(&self) -> AiRunId {
        self.run_id
    }

    /// Generation captured at admission.
    #[must_use]
    pub fn generation(&self) -> Generation {
        Generation::new(self.generation)
    }

    /// Whether this exact run generation remains live.
    #[must_use]
    pub fn is_live(&self) -> bool {
        self.cancel.is_live()
    }

    /// Idempotently cancel this generation's provider work.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Execute provider chat while retaining this guard's tracked authority.
    pub async fn chat(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ProviderChatRequest,
    ) -> Result<Vec<NormalizedStreamEvent>, ProviderError> {
        self.runtime
            .as_ref()
            .expect("admitted AI guard missing runtime")
            .chat(endpoint, request, self.cancel.as_ref())
            .await
    }

    /// Discover provider models while retaining this guard's tracked authority.
    pub async fn discover_models(
        &self,
        endpoint: &ProviderEndpoint,
    ) -> Result<Vec<DiscoveredModel>, ProviderError> {
        self.runtime
            .as_ref()
            .expect("admitted AI guard missing runtime")
            .discover_models(endpoint, self.cancel.as_ref())
            .await
    }
}

impl Drop for AiRunGuard {
    fn drop(&mut self) {
        // Remove the guard's runtime authority before telling drain waiters that
        // this generation is gone.
        drop(self.runtime.take());
        self.supervisor.unregister(self.run_id, self.generation);
    }
}

impl AiRuntimeSupervisor {
    /// Build a supervisor with open admission and no provider runtime.
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(AiRuntimeInner {
                lifecycle: AiRuntimeLifecycle::Accepting,
                runtime: None,
                active: HashMap::new(),
            }),
            drain_notify: Notify::new(),
        })
    }

    /// True while new runs may be admitted.
    #[must_use]
    pub fn is_accepting(&self) -> bool {
        self.inner.lock().expect("AI runtime poisoned").lifecycle == AiRuntimeLifecycle::Accepting
    }

    /// Snapshot of currently registered live runs.
    #[must_use]
    pub fn active_count(&self) -> usize {
        self.inner.lock().expect("AI runtime poisoned").active.len()
    }

    /// True while the supervisor retains a lazy provider runtime shell.
    #[must_use]
    pub fn has_runtime(&self) -> bool {
        self.inner
            .lock()
            .expect("AI runtime poisoned")
            .runtime
            .is_some()
    }

    /// Observation helper: provider HTTP client construction count (0 at startup).
    #[must_use]
    pub fn provider_client_construct_calls(&self) -> usize {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        match inner.runtime.as_ref() {
            Some(runtime) => runtime.factory().construct_calls(),
            None => 0,
        }
    }

    /// Observation helper: whether a provider HTTP client exists.
    #[must_use]
    pub fn provider_client_constructed(&self) -> bool {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        inner
            .runtime
            .as_ref()
            .is_some_and(|runtime| runtime.is_client_constructed())
    }

    /// Atomically admit one durable run generation and its lazy provider runtime.
    ///
    /// Duplicate identities and the concurrent ceiling fail closed. Admission,
    /// runtime creation, and insertion of `(run_id, generation)` share the same
    /// mutex as [`Self::begin_drain`].
    pub fn admit_run(
        self: &Arc<Self>,
        run_id: AiRunId,
        generation: u64,
    ) -> Result<AiRunGuard, AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle != AiRuntimeLifecycle::Accepting {
            return Err(AiRuntimeError::NotAccepting);
        }
        if inner.active.len() >= MAX_ACTIVE_AI_RUNS {
            return Err(AiRuntimeError::Capacity);
        }
        if inner.active.contains_key(&run_id) {
            return Err(AiRuntimeError::Duplicate);
        }

        let runtime = Arc::clone(
            inner
                .runtime
                .get_or_insert_with(|| Arc::new(ProviderRuntime::new())),
        );
        let cancel = Arc::new(RunCancel::for_identity(
            RunId::from_uuid(run_id.as_uuid()),
            Generation::new(generation),
        ));
        inner.active.insert(
            run_id,
            ActiveRun {
                generation,
                cancel: Arc::clone(&cancel),
            },
        );
        Ok(AiRunGuard {
            supervisor: Arc::clone(self),
            run_id,
            generation,
            runtime: Some(runtime),
            cancel,
        })
    }

    /// Idempotently cancel one active run. Unknown runs return [`AiRuntimeError::NotFound`].
    pub fn cancel_run(&self, run_id: AiRunId) -> Result<(), AiRuntimeError> {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        let Some(entry) = inner.active.get(&run_id) else {
            return Err(AiRuntimeError::NotFound);
        };
        entry.cancel.cancel();
        Ok(())
    }

    /// Close admission and cancel every registered generation synchronously.
    ///
    /// `Accepting` transitions to `Draining`; later calls never advance a timed-out
    /// drain to `Drained`. Does not wait for guards to drop.
    pub fn begin_drain(&self) {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle == AiRuntimeLifecycle::Accepting {
            inner.lifecycle = AiRuntimeLifecycle::Draining;
        }
        for entry in inner.active.values() {
            entry.cancel.cancel();
        }
    }

    /// Wait until every run guard has dropped, up to `deadline`.
    ///
    /// Uses notify wakeups; does not sleep-poll for correctness.
    pub async fn wait_drained(&self, deadline: Duration) -> bool {
        let start = tokio::time::Instant::now();
        loop {
            let notified = self.drain_notify.notified();
            {
                let inner = self.inner.lock().expect("AI runtime poisoned");
                if inner.active.is_empty() {
                    return true;
                }
            }
            let elapsed = start.elapsed();
            if elapsed >= deadline {
                let inner = self.inner.lock().expect("AI runtime poisoned");
                return inner.active.is_empty();
            }
            let remaining = deadline.saturating_sub(elapsed);
            if tokio::time::timeout(remaining, notified).await.is_err() {
                let inner = self.inner.lock().expect("AI runtime poisoned");
                return inner.active.is_empty();
            }
        }
    }

    /// Drop the lazy provider runtime after a successful drain.
    ///
    /// Only `Draining`/`Drained` with zero active guards may become `Drained`.
    pub fn drop_runtime(&self) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle == AiRuntimeLifecycle::Accepting {
            return Err(AiRuntimeError::InvalidLifecycle);
        }
        if !inner.active.is_empty() {
            return Err(AiRuntimeError::Busy);
        }
        inner.runtime = None;
        inner.lifecycle = AiRuntimeLifecycle::Drained;
        Ok(())
    }

    /// Re-open admission after a completed provider reconfiguration drain.
    ///
    /// A partial/timed-out drain remains `Draining` and cannot resume even after
    /// its last guard later drops; callers must explicitly finish `drop_runtime`.
    pub fn resume_after_reconfigure(&self) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle != AiRuntimeLifecycle::Drained
            || inner.runtime.is_some()
            || !inner.active.is_empty()
        {
            return Err(AiRuntimeError::InvalidLifecycle);
        }
        inner.lifecycle = AiRuntimeLifecycle::Accepting;
        Ok(())
    }

    /// Close admission, cancel all runs, wait for guards, then drop the runtime.
    ///
    /// On timeout, lifecycle stays `Draining` and the runtime is retained.
    pub async fn drain_and_drop(&self, deadline: Duration) -> bool {
        self.begin_drain();
        if !self.wait_drained(deadline).await {
            return false;
        }
        self.drop_runtime().is_ok()
    }

    fn unregister(&self, run_id: AiRunId, generation: u64) {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let should_notify = match inner.active.get(&run_id) {
            Some(entry) if entry.generation == generation => {
                inner.active.remove(&run_id);
                true
            }
            _ => false,
        };
        drop(inner);
        if should_notify {
            self.drain_notify.notify_waiters();
        }
    }
}

impl std::fmt::Debug for AiRuntimeSupervisor {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        formatter
            .debug_struct("AiRuntimeSupervisor")
            .field("lifecycle", &inner.lifecycle)
            .field("has_runtime", &inner.runtime.is_some())
            .field("active", &inner.active.len())
            .finish()
    }
}

impl std::fmt::Debug for AiRunGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AiRunGuard")
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    use junban_ai::{ChatMessage, ModelId, ProviderPreset, SecretString, descriptor};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    const SYNTHETIC_CREDENTIAL: &str = "synthetic-ai-runtime-test-credential";

    fn cancelled_fixture() -> (ProviderEndpoint, ProviderChatRequest) {
        let endpoint = ProviderEndpoint::resolve(
            descriptor(ProviderPreset::Custom),
            Some("http://127.0.0.1:9/v1"),
            Some(SecretString::new(SYNTHETIC_CREDENTIAL)),
        )
        .expect("loopback fixture endpoint");
        let request = ProviderChatRequest {
            model: ModelId::new("fixture-model").expect("model"),
            messages: vec![ChatMessage::user("fixture")],
            tools: Vec::new(),
            max_output_tokens: Some(8),
        };
        (endpoint, request)
    }

    #[test]
    fn startup_allocates_no_provider_client_or_runtime() {
        let supervisor = AiRuntimeSupervisor::new();
        assert!(supervisor.is_accepting());
        assert!(!supervisor.has_runtime());
        assert_eq!(supervisor.provider_client_construct_calls(), 0);
        assert!(!supervisor.provider_client_constructed());
        assert_eq!(supervisor.active_count(), 0);
    }

    #[tokio::test]
    async fn admitted_guard_is_lazy_and_preserves_private_identity_and_cancellation() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let guard = supervisor.admit_run(run_id, 9).expect("admit");
        assert!(supervisor.has_runtime());
        assert!(!supervisor.provider_client_constructed());
        assert_eq!(supervisor.provider_client_construct_calls(), 0);
        assert_eq!(guard.run_id(), run_id);
        assert_eq!(guard.generation().get(), 9);
        assert_eq!(guard.cancel.run_id().as_uuid(), run_id.as_uuid());
        assert_eq!(guard.cancel.generation().get(), 9);
        assert!(guard.is_live());

        supervisor.cancel_run(run_id).expect("cancel");
        assert!(!guard.is_live());
        guard.cancel();
        let (endpoint, request) = cancelled_fixture();
        assert!(matches!(
            guard.chat(&endpoint, &request).await,
            Err(ProviderError::Cancelled)
        ));
        assert!(matches!(
            guard.discover_models(&endpoint).await,
            Err(ProviderError::Cancelled)
        ));
        assert!(!supervisor.provider_client_constructed());
    }

    #[test]
    fn concurrent_cap_is_four() {
        let supervisor = AiRuntimeSupervisor::new();
        let mut guards = Vec::new();
        for _ in 0..MAX_ACTIVE_AI_RUNS {
            guards.push(supervisor.admit_run(AiRunId::new(), 1).expect("within cap"));
        }
        assert_eq!(
            supervisor.admit_run(AiRunId::new(), 1).unwrap_err(),
            AiRuntimeError::Capacity
        );
        drop(guards);
        supervisor
            .admit_run(AiRunId::new(), 1)
            .expect("after guards drop");
    }

    #[test]
    fn duplicate_run_identity_fails_closed() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let guard = supervisor.admit_run(run_id, 1).expect("first");
        assert_eq!(
            supervisor.admit_run(run_id, 1).unwrap_err(),
            AiRuntimeError::Duplicate
        );
        assert_eq!(
            supervisor.admit_run(run_id, 2).unwrap_err(),
            AiRuntimeError::Duplicate
        );
        drop(guard);
    }

    #[test]
    fn cancel_unknown_is_stable_not_found_without_identity_text() {
        let supervisor = AiRuntimeSupervisor::new();
        let error = supervisor.cancel_run(AiRunId::new()).unwrap_err();
        assert_eq!(error, AiRuntimeError::NotFound);
        let rendered = error.to_string();
        assert!(!rendered.contains('-'));
        assert_eq!(rendered, "AI run was not found");
    }

    #[test]
    fn admit_and_begin_drain_share_one_admission_lock() {
        for _ in 0..64 {
            let supervisor = AiRuntimeSupervisor::new();
            let barrier = Arc::new(Barrier::new(2));
            let admit_supervisor = Arc::clone(&supervisor);
            let drain_supervisor = Arc::clone(&supervisor);
            let admit_barrier = Arc::clone(&barrier);
            let drain_barrier = Arc::clone(&barrier);
            let run_id = AiRunId::new();

            let admit = std::thread::spawn(move || {
                admit_barrier.wait();
                admit_supervisor.admit_run(run_id, 1)
            });
            let drain = std::thread::spawn(move || {
                drain_barrier.wait();
                drain_supervisor.begin_drain();
            });

            let admitted = admit.join().expect("admit thread");
            drain.join().expect("drain thread");
            assert!(!supervisor.is_accepting());
            match admitted {
                Ok(guard) => {
                    assert!(!guard.is_live());
                    drop(guard);
                    assert_eq!(supervisor.active_count(), 0);
                }
                Err(AiRuntimeError::NotAccepting) => {
                    assert_eq!(supervisor.active_count(), 0);
                }
                Err(other) => panic!("unexpected admit error: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn provider_wrapper_future_cannot_escape_guard_tracked_drain() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        let (headers_sent, headers_received) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).await.expect("read request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                .await
                .expect("write headers");
            let _ = headers_sent.send(());
            std::future::pending::<()>().await;
        });

        let endpoint = ProviderEndpoint::resolve(
            descriptor(ProviderPreset::Ollama),
            Some(&format!("http://{address}")),
            None,
        )
        .expect("loopback endpoint");
        let supervisor = AiRuntimeSupervisor::new();
        let guard = supervisor
            .admit_run(AiRunId::new(), 1)
            .expect("admitted run");
        {
            let provider = guard.discover_models(&endpoint);
            tokio::pin!(provider);
            tokio::select! {
                result = &mut provider => panic!("provider ended before hanging body: {result:?}"),
                result = headers_received => result.expect("headers signal"),
            }

            supervisor.begin_drain();
            assert!(!guard.is_live());
            assert!(matches!(
                provider.as_mut().await,
                Err(ProviderError::Cancelled)
            ));
            assert!(!supervisor.wait_drained(Duration::from_millis(10)).await);
            assert_eq!(supervisor.drop_runtime(), Err(AiRuntimeError::Busy));
        }
        drop(guard);
        assert!(supervisor.wait_drained(Duration::from_secs(1)).await);
        supervisor.drop_runtime().expect("drop after guard");
        server.abort();
        let _ = server.await;
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_then_guard_drop_requires_explicit_drop_before_resume() {
        let supervisor = AiRuntimeSupervisor::new();
        let guard = supervisor.admit_run(AiRunId::new(), 1).expect("admit");
        assert!(!supervisor.drain_and_drop(Duration::from_millis(5)).await);
        assert!(!supervisor.is_accepting());
        assert!(supervisor.has_runtime());
        assert_eq!(supervisor.active_count(), 1);
        drop(guard);
        assert!(supervisor.wait_drained(Duration::from_secs(1)).await);
        assert_eq!(
            supervisor.resume_after_reconfigure(),
            Err(AiRuntimeError::InvalidLifecycle)
        );
        assert!(supervisor.has_runtime());
        supervisor.drop_runtime().expect("explicit drop");
        supervisor
            .resume_after_reconfigure()
            .expect("resume after explicit drop");
        assert!(supervisor.is_accepting());
    }

    #[tokio::test(start_paused = true)]
    async fn successful_drop_then_resume_creates_a_fresh_lazy_runtime() {
        let supervisor = AiRuntimeSupervisor::new();
        let guard = supervisor.admit_run(AiRunId::new(), 1).expect("admit");
        let drain = {
            let supervisor = Arc::clone(&supervisor);
            tokio::spawn(async move { supervisor.drain_and_drop(Duration::from_secs(1)).await })
        };
        tokio::task::yield_now().await;
        drop(guard);
        assert!(drain.await.expect("join"));
        assert!(!supervisor.has_runtime());
        assert!(!supervisor.is_accepting());
        supervisor
            .resume_after_reconfigure()
            .expect("resume after clean drop");
        let next = supervisor
            .admit_run(AiRunId::new(), 1)
            .expect("fresh admission");
        assert!(supervisor.has_runtime());
        assert!(next.is_live());
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_lifecycle_is_idempotent() {
        let supervisor = AiRuntimeSupervisor::new();
        assert!(supervisor.drain_and_drop(Duration::from_secs(1)).await);
        assert!(supervisor.drain_and_drop(Duration::from_secs(1)).await);
        assert!(!supervisor.has_runtime());
        assert!(!supervisor.is_accepting());
        assert_eq!(
            supervisor.admit_run(AiRunId::new(), 1).unwrap_err(),
            AiRuntimeError::NotAccepting
        );
    }

    #[test]
    fn drop_removes_only_matching_generation() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let first = supervisor.admit_run(run_id, 1).expect("first");
        supervisor.unregister(run_id, 99);
        assert_eq!(supervisor.active_count(), 1);
        drop(first);
        assert_eq!(supervisor.active_count(), 0);
    }
}
