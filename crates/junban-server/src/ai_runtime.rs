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
use junban_domain::{AiApprovalId, AiRunId, OperationId};

use crate::{
    ai_tool_executor::derive_child_operation_id,
    ai_tool_registry::{ToolResultEnvelope, registration},
};
use tokio::sync::Notify;

/// Hard concurrent ceiling for in-flight AI provider runs in one process.
pub const MAX_ACTIVE_AI_RUNS: usize = 4;
/// Strict process-local decision notification payload ceiling.
pub const MAX_AI_DECISION_PAYLOAD_BYTES: usize = 32 * 1024;

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
    /// Cancel arrived after terminal outcome linearization.
    #[error("AI run is already terminal")]
    Terminal,
    /// A drain or drop was requested while active work remains.
    #[error("AI runtime is still busy")]
    Busy,
    /// The requested transition is not valid in the current lifecycle state.
    #[error("AI runtime lifecycle does not permit this operation")]
    InvalidLifecycle,
    /// Approval decision identity does not match this exact run generation and approval.
    #[error("AI approval decision identity does not match")]
    DecisionIdentityMismatch,
    /// Approval decision is not legal in the run's current process-local phase.
    #[error("AI approval decision is not available")]
    DecisionUnavailable,
    /// A dispatch result is not an exact bounded trusted tool-result envelope.
    #[error("AI dispatch result payload is invalid")]
    InvalidDecisionPayload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiRuntimeLifecycle {
    Accepting,
    Reconfiguring {
        epoch: ReconfigureEpoch,
        runtime_dropped: bool,
    },
    PermanentDraining,
    PermanentDrained,
}

/// Unforgeable authority for one temporary provider reconfiguration lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReconfigureEpoch(u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveRunPhase {
    Running,
    AwaitingApproval(AiApprovalId),
    DecisionAuthorizing {
        approval_id: AiApprovalId,
        cancel_queued: bool,
    },
    CancelRequested,
    Terminal(AiTerminalOutcome),
}

/// Exact trusted result retained only until the run consumes its dispatch notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiDecisionPayload {
    dispatch_operation_id: OperationId,
    terminal_outcome: AiTerminalOutcome,
    tool_result_json: String,
}

impl AiDecisionPayload {
    /// Freeze the exact provider-neutral result the worker must persist and emit.
    pub fn from_tool_result(
        dispatch_operation_id: OperationId,
        terminal_outcome: AiTerminalOutcome,
        tool_result: &ToolResultEnvelope,
    ) -> Result<Self, AiRuntimeError> {
        let public_operation_id = derive_child_operation_id(dispatch_operation_id, "mutation", 0);
        let result_operation_matches = tool_result.operation_id.as_deref().is_none_or(|raw| {
            OperationId::parse(raw)
                .is_ok_and(|parsed| parsed == public_operation_id && parsed.to_string() == raw)
        });
        if terminal_outcome == AiTerminalOutcome::Cancelled
            || registration(&tool_result.tool).is_none()
            || tool_result.operation_id.is_some() != tool_result.revision.is_some()
            || !result_operation_matches
        {
            return Err(AiRuntimeError::InvalidDecisionPayload);
        }
        let created_manifest = tool_result.data.get("created").cloned();
        let bounded = tool_result.clone().finalize_bounded();
        if created_manifest.is_some()
            && (bounded.truncated || bounded.data.get("created") != created_manifest.as_ref())
        {
            return Err(AiRuntimeError::InvalidDecisionPayload);
        }
        let mut value =
            serde_json::to_value(&bounded).map_err(|_| AiRuntimeError::InvalidDecisionPayload)?;
        let mut tool_result_json =
            serde_json::to_string(&value).map_err(|_| AiRuntimeError::InvalidDecisionPayload)?;
        if tool_result_json.len() > MAX_AI_DECISION_PAYLOAD_BYTES {
            if bounded
                .data
                .get("created")
                .is_some_and(serde_json::Value::is_array)
            {
                return Err(AiRuntimeError::InvalidDecisionPayload);
            }
            value = serde_json::to_value(ToolResultEnvelope::error(
                &bounded.tool,
                "result_too_large",
                "tool result exceeds the 32 KiB dispatch bound",
            ))
            .map_err(|_| AiRuntimeError::InvalidDecisionPayload)?;
            tool_result_json = serde_json::to_string(&value)
                .map_err(|_| AiRuntimeError::InvalidDecisionPayload)?;
        }
        if tool_result_json.len() > MAX_AI_DECISION_PAYLOAD_BYTES
            || !serde_json::from_str::<serde_json::Value>(&tool_result_json)
                .is_ok_and(|value| value.is_object())
        {
            return Err(AiRuntimeError::InvalidDecisionPayload);
        }
        Ok(Self {
            dispatch_operation_id,
            terminal_outcome,
            tool_result_json,
        })
    }

    #[must_use]
    pub const fn dispatch_operation_id(&self) -> OperationId {
        self.dispatch_operation_id
    }

    #[must_use]
    pub const fn terminal_outcome(&self) -> AiTerminalOutcome {
        self.terminal_outcome
    }

    #[must_use]
    pub fn tool_result_json(&self) -> &str {
        &self.tool_result_json
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiDecisionNotification {
    Rejected,
    Dispatched(AiDecisionPayload),
    CancelRequested,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiDecisionCompletion {
    Rejected,
    Dispatched(AiDecisionPayload),
    FailedBeforeDispatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiDecisionCompletionState {
    Running,
    AwaitingApproval,
    CancelRequested,
    Terminal(AiTerminalOutcome),
}

/// Stable terminal outcome selected at the process-local linearization point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiTerminalOutcome {
    Completed,
    Cancelled,
    Failed,
}

struct ActiveRun {
    generation: u64,
    cancel: Arc<RunCancel>,
    phase: ActiveRunPhase,
    decision_notify: Arc<Notify>,
    decision_notification: Option<(AiApprovalId, AiDecisionNotification)>,
}

struct AiRuntimeInner {
    lifecycle: AiRuntimeLifecycle,
    next_reconfigure_epoch: u64,
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

/// One-shot authority for an exact run-generation-approval decision.
///
/// Dropping without completion returns a non-cancelled run to the same approval wait.
pub struct AiDecisionPermit {
    supervisor: Arc<AiRuntimeSupervisor>,
    run_id: AiRunId,
    generation: u64,
    approval_id: AiApprovalId,
    completed: bool,
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

    /// Idempotently request cancellation through the shared phase authority.
    pub fn cancel(&self) {
        let _ = self.supervisor.cancel_run(self.run_id);
    }

    /// Check that this exact generation still has provider-output authority.
    #[must_use]
    pub fn may_emit_provider_output(&self) -> bool {
        self.supervisor
            .may_emit_provider_output(self.run_id, self.generation)
    }

    /// Move this exact running generation to one exact approval wait.
    pub fn await_approval(&self, approval_id: AiApprovalId) -> Result<(), AiRuntimeError> {
        self.supervisor
            .await_approval(self.run_id, self.generation, approval_id)
    }

    /// Roll back only a process-local approval transition whose durable proposal failed.
    pub fn abandon_approval(&self, approval_id: AiApprovalId) -> Result<(), AiRuntimeError> {
        self.supervisor
            .abandon_approval(self.run_id, self.generation, approval_id)
    }

    /// Wait without polling for this approval's decision or a winning cancellation.
    pub async fn wait_for_decision(
        &self,
        approval_id: AiApprovalId,
    ) -> Result<AiDecisionNotification, AiRuntimeError> {
        self.supervisor
            .wait_for_decision(self.run_id, self.generation, approval_id)
            .await
    }

    /// Wait for cancellation without exposing the underlying token.
    pub(crate) async fn wait_cancelled(&self) {
        self.cancel.token().cancelled_owned().await;
    }

    /// Commit one already-capacity-reserved output under the run-phase authority.
    ///
    /// The closure is synchronous so no channel or accumulator mutation can escape
    /// the exact `Running` generation check.
    pub(crate) fn commit_provider_output<T>(&self, commit: impl FnOnce() -> T) -> Option<T> {
        self.supervisor
            .commit_provider_output(self.run_id, self.generation, commit)
    }

    /// Atomically select exactly one terminal winner for this generation.
    ///
    /// A prior cancellation always changes a proposed completion/failure into
    /// cancellation. Once selected, neither cancellation nor another terminal
    /// attempt can overwrite the outcome.
    pub fn linearize_terminal(&self, proposed: AiTerminalOutcome) -> Option<AiTerminalOutcome> {
        self.supervisor
            .linearize_terminal(self.run_id, self.generation, proposed)
    }

    /// Check that this guard still owns the exact selected terminal outcome.
    #[must_use]
    pub fn owns_terminal(&self, outcome: AiTerminalOutcome) -> bool {
        self.supervisor
            .owns_terminal(self.run_id, self.generation, outcome)
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

    /// Execute provider chat incrementally while retaining this guard's tracked authority.
    pub async fn chat_stream<F, Fut>(
        &self,
        endpoint: &ProviderEndpoint,
        request: &ProviderChatRequest,
        on_event: F,
    ) -> Result<(), ProviderError>
    where
        F: FnMut(NormalizedStreamEvent) -> Fut,
        Fut: std::future::Future<Output = Result<(), ProviderError>>,
    {
        self.runtime
            .as_ref()
            .expect("admitted AI guard missing runtime")
            .chat_stream(endpoint, request, self.cancel.as_ref(), on_event)
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

impl AiDecisionPermit {
    pub fn complete(
        mut self,
        completion: AiDecisionCompletion,
    ) -> Result<AiDecisionCompletionState, AiRuntimeError> {
        let result = self.supervisor.complete_decision(
            self.run_id,
            self.generation,
            self.approval_id,
            completion,
        );
        self.completed = result.is_ok();
        result
    }
}

impl Drop for AiDecisionPermit {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self.supervisor.complete_decision(
                self.run_id,
                self.generation,
                self.approval_id,
                AiDecisionCompletion::FailedBeforeDispatch,
            );
        }
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
                next_reconfigure_epoch: 1,
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
    /// mutex as [`Self::begin_reconfigure`] and [`Self::begin_permanent_drain`].
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
                phase: ActiveRunPhase::Running,
                decision_notify: Arc::new(Notify::new()),
                decision_notification: None,
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

    /// Idempotently cancel one active run before terminal linearization.
    pub fn cancel_run(&self, run_id: AiRunId) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let Some(entry) = inner.active.get_mut(&run_id) else {
            return Err(AiRuntimeError::NotFound);
        };
        match entry.phase {
            ActiveRunPhase::Running | ActiveRunPhase::AwaitingApproval(_) => {
                entry.phase = ActiveRunPhase::CancelRequested;
                entry.cancel.cancel();
                entry.decision_notify.notify_one();
                Ok(())
            }
            ActiveRunPhase::DecisionAuthorizing { approval_id, .. } => {
                entry.phase = ActiveRunPhase::DecisionAuthorizing {
                    approval_id,
                    cancel_queued: true,
                };
                Ok(())
            }
            ActiveRunPhase::CancelRequested => Ok(()),
            ActiveRunPhase::Terminal(_) => Err(AiRuntimeError::Terminal),
        }
    }

    fn await_approval(
        &self,
        run_id: AiRunId,
        generation: u64,
        approval_id: AiApprovalId,
    ) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let entry = inner
            .active
            .get_mut(&run_id)
            .ok_or(AiRuntimeError::NotFound)?;
        if entry.generation != generation {
            return Err(AiRuntimeError::DecisionIdentityMismatch);
        }
        if entry.phase != ActiveRunPhase::Running || entry.decision_notification.is_some() {
            return Err(AiRuntimeError::DecisionUnavailable);
        }
        entry.phase = ActiveRunPhase::AwaitingApproval(approval_id);
        Ok(())
    }

    fn abandon_approval(
        &self,
        run_id: AiRunId,
        generation: u64,
        approval_id: AiApprovalId,
    ) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let entry = inner
            .active
            .get_mut(&run_id)
            .ok_or(AiRuntimeError::NotFound)?;
        if entry.generation != generation {
            return Err(AiRuntimeError::DecisionIdentityMismatch);
        }
        match entry.phase {
            ActiveRunPhase::AwaitingApproval(bound) if bound == approval_id => {
                entry.phase = ActiveRunPhase::Running;
                Ok(())
            }
            ActiveRunPhase::AwaitingApproval(_) => Err(AiRuntimeError::DecisionIdentityMismatch),
            ActiveRunPhase::CancelRequested => Ok(()),
            _ => Err(AiRuntimeError::DecisionUnavailable),
        }
    }

    pub fn begin_decision(
        self: &Arc<Self>,
        run_id: AiRunId,
        generation: u64,
        approval_id: AiApprovalId,
    ) -> Result<AiDecisionPermit, AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let entry = inner
            .active
            .get_mut(&run_id)
            .ok_or(AiRuntimeError::NotFound)?;
        if entry.generation != generation {
            return Err(AiRuntimeError::DecisionIdentityMismatch);
        }
        match entry.phase {
            ActiveRunPhase::AwaitingApproval(bound) if bound == approval_id => {
                entry.phase = ActiveRunPhase::DecisionAuthorizing {
                    approval_id,
                    cancel_queued: false,
                };
                Ok(AiDecisionPermit {
                    supervisor: Arc::clone(self),
                    run_id,
                    generation,
                    approval_id,
                    completed: false,
                })
            }
            ActiveRunPhase::AwaitingApproval(_) | ActiveRunPhase::DecisionAuthorizing { .. } => {
                Err(AiRuntimeError::DecisionIdentityMismatch)
            }
            _ => Err(AiRuntimeError::DecisionUnavailable),
        }
    }

    async fn wait_for_decision(
        &self,
        run_id: AiRunId,
        generation: u64,
        approval_id: AiApprovalId,
    ) -> Result<AiDecisionNotification, AiRuntimeError> {
        let notify = {
            let inner = self.inner.lock().expect("AI runtime poisoned");
            let entry = inner.active.get(&run_id).ok_or(AiRuntimeError::NotFound)?;
            if entry.generation != generation {
                return Err(AiRuntimeError::DecisionIdentityMismatch);
            }
            Arc::clone(&entry.decision_notify)
        };
        loop {
            let notified = notify.notified();
            {
                let mut inner = self.inner.lock().expect("AI runtime poisoned");
                let entry = inner
                    .active
                    .get_mut(&run_id)
                    .ok_or(AiRuntimeError::NotFound)?;
                if entry.generation != generation {
                    return Err(AiRuntimeError::DecisionIdentityMismatch);
                }
                if entry
                    .decision_notification
                    .as_ref()
                    .is_some_and(|(bound, _)| *bound != approval_id)
                {
                    return Err(AiRuntimeError::DecisionIdentityMismatch);
                }
                if let Some((_, notification)) = entry.decision_notification.take() {
                    return Ok(notification);
                }
                match entry.phase {
                    ActiveRunPhase::CancelRequested => {
                        return Ok(AiDecisionNotification::CancelRequested);
                    }
                    ActiveRunPhase::AwaitingApproval(bound)
                    | ActiveRunPhase::DecisionAuthorizing {
                        approval_id: bound, ..
                    } if bound == approval_id => {}
                    ActiveRunPhase::AwaitingApproval(_)
                    | ActiveRunPhase::DecisionAuthorizing { .. } => {
                        return Err(AiRuntimeError::DecisionIdentityMismatch);
                    }
                    _ => return Err(AiRuntimeError::DecisionUnavailable),
                }
            }
            notified.await;
        }
    }

    fn complete_decision(
        &self,
        run_id: AiRunId,
        generation: u64,
        approval_id: AiApprovalId,
        completion: AiDecisionCompletion,
    ) -> Result<AiDecisionCompletionState, AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let entry = inner
            .active
            .get_mut(&run_id)
            .ok_or(AiRuntimeError::NotFound)?;
        if entry.generation != generation {
            return Err(AiRuntimeError::DecisionIdentityMismatch);
        }
        let cancel_queued = match entry.phase {
            ActiveRunPhase::DecisionAuthorizing {
                approval_id: bound,
                cancel_queued,
            } if bound == approval_id => cancel_queued,
            ActiveRunPhase::DecisionAuthorizing { .. } => {
                return Err(AiRuntimeError::DecisionIdentityMismatch);
            }
            _ => return Err(AiRuntimeError::DecisionUnavailable),
        };
        let state = match completion {
            AiDecisionCompletion::Rejected if cancel_queued => {
                entry.phase = ActiveRunPhase::CancelRequested;
                entry.cancel.cancel();
                entry.decision_notify.notify_one();
                AiDecisionCompletionState::CancelRequested
            }
            AiDecisionCompletion::Rejected => {
                entry.phase = ActiveRunPhase::Running;
                entry.decision_notification = Some((approval_id, AiDecisionNotification::Rejected));
                entry.decision_notify.notify_one();
                AiDecisionCompletionState::Running
            }
            AiDecisionCompletion::Dispatched(payload) => {
                let outcome = payload.terminal_outcome();
                if cancel_queued {
                    // Durable dispatch already won. Cancellation only prevents any
                    // subsequent provider work and cannot overwrite that terminal result.
                    entry.cancel.cancel();
                }
                entry.phase = ActiveRunPhase::Terminal(outcome);
                entry.decision_notification =
                    Some((approval_id, AiDecisionNotification::Dispatched(payload)));
                entry.decision_notify.notify_one();
                AiDecisionCompletionState::Terminal(outcome)
            }
            AiDecisionCompletion::FailedBeforeDispatch if cancel_queued => {
                entry.phase = ActiveRunPhase::CancelRequested;
                entry.cancel.cancel();
                entry.decision_notify.notify_one();
                AiDecisionCompletionState::CancelRequested
            }
            AiDecisionCompletion::FailedBeforeDispatch => {
                entry.phase = ActiveRunPhase::AwaitingApproval(approval_id);
                AiDecisionCompletionState::AwaitingApproval
            }
        };
        Ok(state)
    }

    /// Begin one temporary reconfiguration epoch, closing admission and cancelling runs.
    ///
    /// Only accepting state may start an epoch. A timed-out epoch remains fail-closed and
    /// cannot be replaced or resumed by a later request.
    pub(crate) fn begin_reconfigure(&self) -> Result<ReconfigureEpoch, AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle != AiRuntimeLifecycle::Accepting {
            return Err(AiRuntimeError::InvalidLifecycle);
        }
        let epoch = ReconfigureEpoch(inner.next_reconfigure_epoch);
        inner.next_reconfigure_epoch = inner.next_reconfigure_epoch.wrapping_add(1).max(1);
        inner.lifecycle = AiRuntimeLifecycle::Reconfiguring {
            epoch,
            runtime_dropped: false,
        };
        for entry in inner.active.values_mut() {
            request_cancel(entry);
        }
        Ok(epoch)
    }

    /// Enter the non-resumable restore/shutdown lifecycle and invalidate any temporary epoch.
    pub fn begin_permanent_drain(&self) {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle != AiRuntimeLifecycle::PermanentDrained {
            inner.lifecycle = AiRuntimeLifecycle::PermanentDraining;
        }
        for entry in inner.active.values_mut() {
            request_cancel(entry);
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

    /// Drop the lazy provider runtime for the exact, still-current temporary epoch.
    pub(crate) fn drop_reconfigure_runtime(
        &self,
        epoch: ReconfigureEpoch,
    ) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle
            != (AiRuntimeLifecycle::Reconfiguring {
                epoch,
                runtime_dropped: false,
            })
        {
            return Err(AiRuntimeError::InvalidLifecycle);
        }
        if !inner.active.is_empty() {
            return Err(AiRuntimeError::Busy);
        }
        inner.runtime = None;
        inner.lifecycle = AiRuntimeLifecycle::Reconfiguring {
            epoch,
            runtime_dropped: true,
        };
        Ok(())
    }

    pub(crate) fn validate_finish_reconfigure(
        &self,
        epoch: ReconfigureEpoch,
    ) -> Result<(), AiRuntimeError> {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle
            != (AiRuntimeLifecycle::Reconfiguring {
                epoch,
                runtime_dropped: true,
            })
            || inner.runtime.is_some()
            || !inner.active.is_empty()
        {
            return Err(AiRuntimeError::InvalidLifecycle);
        }
        Ok(())
    }

    /// Re-open admission only for the exact epoch whose runtime was successfully dropped.
    pub(crate) fn finish_reconfigure(&self, epoch: ReconfigureEpoch) -> Result<(), AiRuntimeError> {
        self.validate_finish_reconfigure(epoch)?;
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        if inner.lifecycle
            != (AiRuntimeLifecycle::Reconfiguring {
                epoch,
                runtime_dropped: true,
            })
            || inner.runtime.is_some()
            || !inner.active.is_empty()
        {
            return Err(AiRuntimeError::InvalidLifecycle);
        }
        inner.lifecycle = AiRuntimeLifecycle::Accepting;
        Ok(())
    }

    /// Drop the lazy runtime only from the non-resumable permanent drain lifecycle.
    pub fn drop_permanent_runtime(&self) -> Result<(), AiRuntimeError> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        match inner.lifecycle {
            AiRuntimeLifecycle::PermanentDraining | AiRuntimeLifecycle::PermanentDrained => {}
            AiRuntimeLifecycle::Accepting | AiRuntimeLifecycle::Reconfiguring { .. } => {
                return Err(AiRuntimeError::InvalidLifecycle);
            }
        }
        if !inner.active.is_empty() {
            return Err(AiRuntimeError::Busy);
        }
        inner.runtime = None;
        inner.lifecycle = AiRuntimeLifecycle::PermanentDrained;
        Ok(())
    }

    /// Permanently close admission, cancel runs, wait for guards, and drop the runtime.
    ///
    /// On timeout, lifecycle stays permanently draining and cannot be resumed.
    pub async fn permanent_drain_and_drop(&self, deadline: Duration) -> bool {
        self.begin_permanent_drain();
        if !self.wait_drained(deadline).await {
            return false;
        }
        self.drop_permanent_runtime().is_ok()
    }

    pub(crate) fn is_active_generation(&self, run_id: AiRunId, generation: u64) -> bool {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        inner
            .active
            .get(&run_id)
            .is_some_and(|entry| entry.generation == generation)
    }

    fn may_emit_provider_output(&self, run_id: AiRunId, generation: u64) -> bool {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        output_is_live(&inner, run_id, generation)
    }

    fn commit_provider_output<T>(
        &self,
        run_id: AiRunId,
        generation: u64,
        commit: impl FnOnce() -> T,
    ) -> Option<T> {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        output_is_live(&inner, run_id, generation).then(commit)
    }

    fn linearize_terminal(
        &self,
        run_id: AiRunId,
        generation: u64,
        proposed: AiTerminalOutcome,
    ) -> Option<AiTerminalOutcome> {
        let mut inner = self.inner.lock().expect("AI runtime poisoned");
        let entry = inner.active.get_mut(&run_id)?;
        if entry.generation != generation {
            return None;
        }
        let outcome = match entry.phase {
            ActiveRunPhase::Running => proposed,
            ActiveRunPhase::CancelRequested => AiTerminalOutcome::Cancelled,
            ActiveRunPhase::AwaitingApproval(_)
            | ActiveRunPhase::DecisionAuthorizing { .. }
            | ActiveRunPhase::Terminal(_) => return None,
        };
        entry.phase = ActiveRunPhase::Terminal(outcome);
        Some(outcome)
    }

    fn owns_terminal(&self, run_id: AiRunId, generation: u64, outcome: AiTerminalOutcome) -> bool {
        let inner = self.inner.lock().expect("AI runtime poisoned");
        inner.active.get(&run_id).is_some_and(|entry| {
            entry.generation == generation && entry.phase == ActiveRunPhase::Terminal(outcome)
        })
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

fn request_cancel(entry: &mut ActiveRun) {
    match entry.phase {
        ActiveRunPhase::Running | ActiveRunPhase::AwaitingApproval(_) => {
            entry.phase = ActiveRunPhase::CancelRequested;
            entry.cancel.cancel();
            entry.decision_notify.notify_one();
        }
        ActiveRunPhase::DecisionAuthorizing { approval_id, .. } => {
            entry.phase = ActiveRunPhase::DecisionAuthorizing {
                approval_id,
                cancel_queued: true,
            };
        }
        ActiveRunPhase::CancelRequested | ActiveRunPhase::Terminal(_) => {}
    }
}

fn output_is_live(inner: &AiRuntimeInner, run_id: AiRunId, generation: u64) -> bool {
    inner.active.get(&run_id).is_some_and(|entry| {
        entry.generation == generation
            && entry.phase == ActiveRunPhase::Running
            && entry.cancel.is_live()
    })
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
    fn cancellation_and_completion_linearize_under_one_authority() {
        for _ in 0..100 {
            let supervisor = AiRuntimeSupervisor::new();
            let run_id = AiRunId::new();
            let guard = supervisor.admit_run(run_id, 1).unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let cancel_supervisor = Arc::clone(&supervisor);
            let cancel_barrier = Arc::clone(&barrier);
            let cancel = std::thread::spawn(move || {
                cancel_barrier.wait();
                cancel_supervisor.cancel_run(run_id)
            });
            barrier.wait();
            let terminal = guard.linearize_terminal(AiTerminalOutcome::Completed);
            let cancel = cancel.join().unwrap();
            match (terminal, cancel) {
                (Some(AiTerminalOutcome::Completed), Err(AiRuntimeError::Terminal)) => {
                    assert!(guard.owns_terminal(AiTerminalOutcome::Completed));
                }
                (Some(AiTerminalOutcome::Cancelled), Ok(())) => {
                    assert!(guard.owns_terminal(AiTerminalOutcome::Cancelled));
                }
                other => panic!("invalid cancel/completion linearization: {other:?}"),
            }
            assert!(
                guard
                    .linearize_terminal(AiTerminalOutcome::Failed)
                    .is_none()
            );
        }
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
    fn admit_and_permanent_drain_share_one_admission_lock() {
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
                drain_supervisor.begin_permanent_drain();
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

            supervisor.begin_permanent_drain();
            assert!(!guard.is_live());
            assert!(matches!(
                provider.as_mut().await,
                Err(ProviderError::Cancelled)
            ));
            assert!(!supervisor.wait_drained(Duration::from_millis(10)).await);
            assert_eq!(
                supervisor.drop_permanent_runtime(),
                Err(AiRuntimeError::Busy)
            );
        }
        drop(guard);
        assert!(supervisor.wait_drained(Duration::from_secs(1)).await);
        supervisor
            .drop_permanent_runtime()
            .expect("drop after guard");
        server.abort();
        let _ = server.await;
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_reconfigure_stays_fail_closed_after_guard_drop() {
        let supervisor = AiRuntimeSupervisor::new();
        let guard = supervisor.admit_run(AiRunId::new(), 1).expect("admit");
        let epoch = supervisor.begin_reconfigure().expect("begin epoch");
        assert!(!supervisor.wait_drained(Duration::from_millis(5)).await);
        assert!(!supervisor.is_accepting());
        assert!(supervisor.has_runtime());
        assert_eq!(supervisor.active_count(), 1);
        drop(guard);
        assert!(supervisor.wait_drained(Duration::from_secs(1)).await);
        assert_eq!(
            supervisor.finish_reconfigure(epoch),
            Err(AiRuntimeError::InvalidLifecycle)
        );
        assert!(supervisor.has_runtime());
        assert!(!supervisor.is_accepting());
    }

    #[tokio::test(start_paused = true)]
    async fn successful_epoch_drop_then_finish_creates_a_fresh_lazy_runtime() {
        let supervisor = AiRuntimeSupervisor::new();
        let guard = supervisor.admit_run(AiRunId::new(), 1).expect("admit");
        let epoch = supervisor.begin_reconfigure().expect("begin epoch");
        let drain = {
            let supervisor = Arc::clone(&supervisor);
            tokio::spawn(async move {
                assert!(supervisor.wait_drained(Duration::from_secs(1)).await);
                supervisor.drop_reconfigure_runtime(epoch)
            })
        };
        tokio::task::yield_now().await;
        drop(guard);
        drain.await.expect("join").expect("drop runtime");
        assert!(!supervisor.has_runtime());
        assert!(!supervisor.is_accepting());
        supervisor
            .finish_reconfigure(epoch)
            .expect("finish exact epoch");
        let next = supervisor
            .admit_run(AiRunId::new(), 1)
            .expect("fresh admission");
        assert!(supervisor.has_runtime());
        assert!(next.is_live());
    }

    #[test]
    fn permanent_drain_invalidates_reconfigure_epoch_and_never_resumes() {
        let supervisor = AiRuntimeSupervisor::new();
        let epoch = supervisor.begin_reconfigure().expect("begin epoch");
        supervisor
            .drop_reconfigure_runtime(epoch)
            .expect("drop for epoch");
        supervisor.begin_permanent_drain();
        assert_eq!(
            supervisor.finish_reconfigure(epoch),
            Err(AiRuntimeError::InvalidLifecycle)
        );
        supervisor
            .drop_permanent_runtime()
            .expect("finish permanent drop");
        assert!(!supervisor.is_accepting());
        assert_eq!(
            supervisor.finish_reconfigure(epoch),
            Err(AiRuntimeError::InvalidLifecycle)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_lifecycle_is_idempotent() {
        let supervisor = AiRuntimeSupervisor::new();
        assert!(
            supervisor
                .permanent_drain_and_drop(Duration::from_secs(1))
                .await
        );
        assert!(
            supervisor
                .permanent_drain_and_drop(Duration::from_secs(1))
                .await
        );
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

    fn decision_payload() -> AiDecisionPayload {
        let dispatch_operation_id =
            OperationId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let result = ToolResultEnvelope::success(
            "create_task",
            serde_json::json!({"task_id":"00000000-0000-4000-8000-000000000001"}),
        )
        .finalize_bounded();
        AiDecisionPayload::from_tool_result(
            dispatch_operation_id,
            AiTerminalOutcome::Completed,
            &result,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn cancellation_before_authorization_blocks_decision() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let approval_id = AiApprovalId::new();
        let guard = supervisor.admit_run(run_id, 3).unwrap();
        guard.await_approval(approval_id).unwrap();
        supervisor.cancel_run(run_id).unwrap();
        assert_eq!(
            supervisor
                .begin_decision(run_id, 3, approval_id)
                .err()
                .unwrap(),
            AiRuntimeError::DecisionUnavailable
        );
        assert_eq!(
            guard.wait_for_decision(approval_id).await.unwrap(),
            AiDecisionNotification::CancelRequested
        );
    }

    #[tokio::test]
    async fn dispatched_authorization_notification_wins_over_queued_cancel() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let approval_id = AiApprovalId::new();
        let guard = supervisor.admit_run(run_id, 1).unwrap();
        guard.await_approval(approval_id).unwrap();
        let permit = supervisor.begin_decision(run_id, 1, approval_id).unwrap();
        supervisor.cancel_run(run_id).unwrap();
        assert!(
            guard.is_live(),
            "authorizing cancellation must remain queued"
        );
        assert_eq!(
            permit
                .complete(AiDecisionCompletion::Dispatched(decision_payload()))
                .unwrap(),
            AiDecisionCompletionState::Terminal(AiTerminalOutcome::Completed)
        );
        let notification = guard.wait_for_decision(approval_id).await.unwrap();
        let AiDecisionNotification::Dispatched(payload) = notification else {
            panic!("dispatch result was not delivered");
        };
        assert_eq!(payload.terminal_outcome(), AiTerminalOutcome::Completed);
        assert!(payload.tool_result_json().contains("create_task"));
        assert!(!guard.is_live());
        assert!(guard.owns_terminal(AiTerminalOutcome::Completed));
        assert_eq!(
            guard.linearize_terminal(AiTerminalOutcome::Cancelled),
            None,
            "queued cancellation cannot overwrite durable dispatch completion"
        );
    }

    #[tokio::test]
    async fn authorization_failure_and_permit_drop_preserve_exact_cancel_semantics() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let approval_id = AiApprovalId::new();
        let guard = supervisor.admit_run(run_id, 2).unwrap();
        guard.await_approval(approval_id).unwrap();
        let permit = supervisor.begin_decision(run_id, 2, approval_id).unwrap();
        supervisor.cancel_run(run_id).unwrap();
        assert_eq!(
            permit
                .complete(AiDecisionCompletion::FailedBeforeDispatch)
                .unwrap(),
            AiDecisionCompletionState::CancelRequested
        );
        assert_eq!(
            guard.wait_for_decision(approval_id).await.unwrap(),
            AiDecisionNotification::CancelRequested
        );

        drop(guard);
        let second_run = AiRunId::new();
        let second_approval = AiApprovalId::new();
        let second = supervisor.admit_run(second_run, 4).unwrap();
        second.await_approval(second_approval).unwrap();
        drop(
            supervisor
                .begin_decision(second_run, 4, second_approval)
                .unwrap(),
        );
        let retry = supervisor
            .begin_decision(second_run, 4, second_approval)
            .unwrap();
        assert_eq!(
            retry.complete(AiDecisionCompletion::Rejected).unwrap(),
            AiDecisionCompletionState::Running
        );
        assert_eq!(
            second.wait_for_decision(second_approval).await.unwrap(),
            AiDecisionNotification::Rejected
        );
    }

    #[tokio::test(start_paused = true)]
    async fn dispatch_queued_cancel_completion_is_exact_terminal_and_blocks_drain_until_drop() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let approval_id = AiApprovalId::new();
        let guard = supervisor.admit_run(run_id, 1).unwrap();
        guard.await_approval(approval_id).unwrap();
        let permit = supervisor.begin_decision(run_id, 1, approval_id).unwrap();
        // This models the detached worker after durable consume: reconfiguration
        // queues cancellation while execution and atomic durable finish still own the permit.
        let epoch = supervisor.begin_reconfigure().unwrap();
        assert!(!supervisor.wait_drained(Duration::from_millis(1)).await);
        let payload = decision_payload();
        assert_eq!(
            permit
                .complete(AiDecisionCompletion::Dispatched(payload.clone()))
                .unwrap(),
            AiDecisionCompletionState::Terminal(AiTerminalOutcome::Completed)
        );
        assert!(guard.owns_terminal(AiTerminalOutcome::Completed));
        assert_eq!(guard.linearize_terminal(AiTerminalOutcome::Cancelled), None);
        assert_eq!(
            guard.wait_for_decision(approval_id).await.unwrap(),
            AiDecisionNotification::Dispatched(payload)
        );
        assert!(!supervisor.wait_drained(Duration::from_millis(1)).await);
        drop(guard);
        assert!(supervisor.wait_drained(Duration::from_secs(1)).await);
        supervisor.drop_reconfigure_runtime(epoch).unwrap();
        supervisor.finish_reconfigure(epoch).unwrap();
    }

    #[test]
    fn cancel_and_authorization_linearize_under_one_barrier() {
        for _ in 0..64 {
            let supervisor = AiRuntimeSupervisor::new();
            let run_id = AiRunId::new();
            let approval_id = AiApprovalId::new();
            let guard = supervisor.admit_run(run_id, 1).unwrap();
            guard.await_approval(approval_id).unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let cancel_supervisor = Arc::clone(&supervisor);
            let cancel_barrier = Arc::clone(&barrier);
            let cancel = std::thread::spawn(move || {
                cancel_barrier.wait();
                cancel_supervisor.cancel_run(run_id)
            });
            barrier.wait();
            let decision = supervisor.begin_decision(run_id, 1, approval_id);
            let cancelled = cancel.join().unwrap();
            match (decision, cancelled) {
                (Err(AiRuntimeError::DecisionUnavailable), Ok(())) => {}
                (Ok(permit), Ok(())) => {
                    assert_eq!(
                        permit
                            .complete(AiDecisionCompletion::Dispatched(decision_payload()))
                            .unwrap(),
                        AiDecisionCompletionState::Terminal(AiTerminalOutcome::Completed)
                    );
                }
                _ => panic!("invalid cancel/decision linearization"),
            }
        }
    }

    #[test]
    fn decision_payload_rejects_cancelled_and_bounds_more_than_32_kib() {
        let operation_id = OperationId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let ordinary = ToolResultEnvelope::success("create_task", serde_json::json!({}));
        assert_eq!(
            AiDecisionPayload::from_tool_result(
                operation_id,
                AiTerminalOutcome::Cancelled,
                &ordinary,
            )
            .unwrap_err(),
            AiRuntimeError::InvalidDecisionPayload
        );
        let oversized = ToolResultEnvelope::success(
            "create_task",
            serde_json::json!({"text": "x".repeat(MAX_AI_DECISION_PAYLOAD_BYTES)}),
        );
        let bounded = AiDecisionPayload::from_tool_result(
            operation_id,
            AiTerminalOutcome::Completed,
            &oversized,
        )
        .unwrap();
        assert!(bounded.tool_result_json().len() <= MAX_AI_DECISION_PAYLOAD_BYTES);
        assert!(bounded.tool_result_json().contains("result_too_large"));

        let oversized_manifest = ToolResultEnvelope::success(
            "bulk_create_tasks",
            serde_json::json!({
                "created": [{
                    "task_id": "x".repeat(MAX_AI_DECISION_PAYLOAD_BYTES * 10),
                    "operation_id": "child",
                    "revision": 1,
                    "event_type": "task.created",
                }],
            }),
        );
        assert_eq!(
            crate::ai_tool_transcript::bound_chat_result(oversized_manifest.clone()).unwrap_err(),
            junban_app::AppError::ResultLimitExceeded
        );
        assert_eq!(
            AiDecisionPayload::from_tool_result(
                operation_id,
                AiTerminalOutcome::Completed,
                &oversized_manifest,
            )
            .unwrap_err(),
            AiRuntimeError::InvalidDecisionPayload
        );

        let other_operation_id =
            OperationId::parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let mismatched = ToolResultEnvelope::success("create_task", serde_json::json!({}))
            .with_mutation_meta(other_operation_id, 1);
        assert_eq!(
            AiDecisionPayload::from_tool_result(
                operation_id,
                AiTerminalOutcome::Completed,
                &mismatched,
            )
            .unwrap_err(),
            AiRuntimeError::InvalidDecisionPayload
        );
    }

    #[test]
    fn decision_identity_mismatch_fails_closed() {
        let supervisor = AiRuntimeSupervisor::new();
        let run_id = AiRunId::new();
        let approval_id = AiApprovalId::new();
        let guard = supervisor.admit_run(run_id, 7).unwrap();
        guard.await_approval(approval_id).unwrap();
        assert_eq!(
            supervisor
                .begin_decision(run_id, 8, approval_id)
                .err()
                .unwrap(),
            AiRuntimeError::DecisionIdentityMismatch
        );
        assert_eq!(
            supervisor
                .begin_decision(run_id, 7, AiApprovalId::new())
                .err()
                .unwrap(),
            AiRuntimeError::DecisionIdentityMismatch
        );
    }
}
