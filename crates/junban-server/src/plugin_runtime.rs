//! Lazy, single-owner parent supervisor for one exact plugin runtime graph.
//!
//! The supervisor is deliberately not composed into ordinary server startup or
//! restore yet. It owns the bounded parent actor, the selected child process,
//! runtime admission, invocation correlation, and graph-failure fencing. Guest
//! capabilities and concrete effects remain outside this slice.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, hash_map::Entry},
    future::Future,
    io::Read as _,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use jiff::Timestamp;
use junban_app::{
    AppError, CommittedPluginInvocation, CompletePluginActivationRequest, DuePluginRetryRequest,
    InstalledPlugin, InstalledPluginProfile, OpenedPluginComponentSource,
    PluginAttemptFailureCause, PluginComponentSelection, PluginGraphFenceCause,
    PluginGraphFenceDisposition, PluginGraphFenceEntry, PluginGraphFenceRequest, PluginHookKind,
    PluginPackageReconciliation, PluginRuntimeState, RecordPluginAttemptFailureRequest,
    ReservePluginInvocationRequest, ReservedPluginInvocation,
};
use junban_domain::OperationId;
use junban_plugin_sdk::{
    AuthorityFence, CallbackFence, ChildFrame, HostCallKind, HostCallReply, HostCallRequest,
    HostFailureCode, InvocationKind, InvocationOutcome as GuestInvocationOutcome,
    InvocationRequest, ParentFrame, ParentMessage, PermissionScope, PluginId, RuntimeLimits,
    Sha256Digest, canonical_permission_hash, decode_host_call_request, decode_invocation_outcome,
    private_body_types::{
        DeliveryState, ErrorCode, HostError, HttpError, HttpErrorCode, PluginError, WitResult,
    },
    validate_capability_reply, validate_capability_request_authority,
};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use crate::{
    plugin_host_process::{
        PendingPluginHostBodyToken, PluginHostLoad, PluginHostProcess, PluginHostProcessError,
        PluginHostRuntimeDriverHandle, PluginHostRuntimeEvent, PluginHostRuntimeEvents,
    },
    sse::AppService,
};

const ACTOR_COMMAND_CAPACITY: usize = 8;
const DRIVER_EVENT_CAPACITY: usize = 8;
const INTERNAL_EVENT_CAPACITY: usize = 8;
const ACTIVE_INVOCATIONS_MAX: usize = junban_plugin_sdk::HOST_CONCURRENT_INVOCATIONS_MAX;
const SERVICE_ANCESTRY_DEPTH_MAX: u8 = 8;
const DRAIN_DEADLINE: Duration = Duration::from_millis(1_000);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginRuntimeLifecycle {
    Dormant,
    Loading,
    Running,
    Draining,
    Fenced,
    Shutdown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginRuntimeSnapshot {
    pub lifecycle: PluginRuntimeLifecycle,
    pub graph_size: usize,
    pub active_invocations: usize,
    pub admitting_plugins: Vec<PluginId>,
}

impl PluginRuntimeSnapshot {
    fn dormant() -> Self {
        Self {
            lifecycle: PluginRuntimeLifecycle::Dormant,
            graph_size: 0,
            active_invocations: 0,
            admitting_plugins: Vec::new(),
        }
    }
}

/// Stable parent-owned failures. Process, path, provider, and raw protocol
/// details never cross this boundary.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum PluginRuntimeError {
    #[error("the plugin runtime is dormant")]
    Dormant,
    #[error("the plugin runtime is not admitting this plugin")]
    NotAdmitting,
    #[error("the plugin runtime reached its total invocation limit")]
    InvocationLimit,
    #[error("the plugin already has an active invocation")]
    PluginBusy,
    #[error("same-plugin service reentrancy is not allowed")]
    ReentrantService,
    #[error("the service invocation ancestry contains a cycle")]
    ServiceCycle,
    #[error("the service invocation ancestry is too deep")]
    ServiceDepth,
    #[error("the requested dependency service is unavailable")]
    ServiceUnavailable,
    #[error("durable plugin authority rejected the operation")]
    AuthorityRejected,
    #[error("the plugin child session was lost")]
    SessionLost,
    #[error("the plugin runtime is fenced")]
    Fenced,
    #[error("the plugin runtime is draining or shut down")]
    Closed,
    #[error("the plugin runtime command queue is full")]
    Busy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvocationFailure {
    GuestTrap,
    Timeout,
    ResourceLimit,
    InvalidOutput,
    AuthorityRejected,
    SessionLost,
}

#[derive(Debug)]
pub enum InvocationOutcome {
    Completed(Box<GuestInvocationOutcome>),
    Replayed(Box<CommittedPluginInvocation>),
    Cancelled,
    Failed(InvocationFailure),
}

#[derive(Clone, Debug)]
pub struct PluginInvocationDispatch {
    pub reservation: ReservePluginInvocationRequest,
    pub request: InvocationRequest,
}

/// A caller-owned terminal receiver. Dropping it always publishes a durable
/// cancellation signal: bounded `try_send` is only the wakeup fast path, while
/// the actor also scans the shared atomic before every wait.
pub struct PluginInvocationHandle {
    invocation_id: OperationId,
    terminal: Option<oneshot::Receiver<InvocationOutcome>>,
    cancel_requested: Arc<AtomicBool>,
    commands: mpsc::WeakSender<ActorCommand>,
    completed: bool,
}

impl PluginInvocationHandle {
    pub async fn outcome(mut self) -> Result<InvocationOutcome, PluginRuntimeError> {
        let terminal = self.terminal.take().ok_or(PluginRuntimeError::Closed)?;
        let outcome = terminal.await.map_err(|_| PluginRuntimeError::Closed)?;
        self.completed = true;
        Ok(outcome)
    }

    pub fn cancel(&self) {
        self.cancel_requested.store(true, Ordering::Release);
        if let Some(commands) = self.commands.upgrade() {
            let _ = commands.try_send(ActorCommand::Cancel {
                invocation_id: self.invocation_id,
            });
        }
    }
}

impl Drop for PluginInvocationHandle {
    fn drop(&mut self) {
        if !self.completed && self.terminal.is_some() {
            self.cancel();
        }
    }
}

#[derive(Clone)]
pub struct PluginHostLaunchPolicy {
    mode: LaunchMode,
}

#[derive(Clone)]
enum LaunchMode {
    ProductSibling,
    #[cfg(test)]
    Explicit {
        executable: std::path::PathBuf,
        deadlines: crate::plugin_host_process::ProcessDeadlines,
        sessions: Arc<Mutex<std::collections::VecDeque<Uuid>>>,
        launched_pids: Arc<Mutex<Vec<u32>>>,
    },
}

impl Default for PluginHostLaunchPolicy {
    fn default() -> Self {
        Self {
            mode: LaunchMode::ProductSibling,
        }
    }
}

impl PluginHostLaunchPolicy {
    fn next_session_id(&self) -> Result<Uuid, PluginHostProcessError> {
        match &self.mode {
            LaunchMode::ProductSibling => Ok(Uuid::now_v7()),
            #[cfg(test)]
            LaunchMode::Explicit { sessions, .. } => sessions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop_front()
                .ok_or(PluginHostProcessError::Closed),
        }
    }

    fn connect(&self, session_id: Uuid) -> Result<PluginHostProcess, PluginHostProcessError> {
        match &self.mode {
            LaunchMode::ProductSibling => PluginHostProcess::connect(session_id),
            #[cfg(test)]
            LaunchMode::Explicit {
                executable,
                deadlines,
                launched_pids,
                ..
            } => {
                let process =
                    PluginHostProcess::connect_for_test(executable, session_id, *deadlines)?;
                if let Some(pid) = process.process_id() {
                    launched_pids
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(pid);
                }
                Ok(process)
            }
        }
    }

    #[cfg(test)]
    fn explicit(
        executable: std::path::PathBuf,
        deadlines: crate::plugin_host_process::ProcessDeadlines,
        sessions: Vec<Uuid>,
        launched_pids: Arc<Mutex<Vec<u32>>>,
    ) -> Self {
        Self {
            mode: LaunchMode::Explicit {
                executable,
                deadlines,
                sessions: Arc::new(Mutex::new(sessions.into())),
                launched_pids,
            },
        }
    }
}

type ServiceFuture<T> = Pin<Box<dyn Future<Output = Result<T, AppError>> + Send>>;

trait RuntimeServicePort: Send + Sync {
    fn profile(&self) -> ServiceFuture<InstalledPluginProfile>;
    fn open_sources(
        &self,
        selected: Vec<PluginComponentSelection>,
    ) -> ServiceFuture<Vec<OpenedPluginComponentSource>>;
    fn reconcile_packages(&self, now: Timestamp) -> ServiceFuture<PluginPackageReconciliation>;
    fn retry_due(
        &self,
        operation_id: OperationId,
        request: DuePluginRetryRequest,
        now: Timestamp,
    ) -> ServiceFuture<()>;
    fn complete_activation(
        &self,
        operation_id: OperationId,
        request: CompletePluginActivationRequest,
        now: Timestamp,
    ) -> ServiceFuture<()>;
    fn cursor(&self, plugin_id: PluginId) -> ServiceFuture<junban_app::PluginEventCursor>;
    fn reserve_invocation(
        &self,
        request: ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> ServiceFuture<ReservedPluginInvocation>;
    fn complete_invocation(
        &self,
        operation_id: OperationId,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        now: Timestamp,
    ) -> ServiceFuture<CommittedPluginInvocation>;
    fn record_failure(
        &self,
        operation_id: OperationId,
        request: RecordPluginAttemptFailureRequest,
        now: Timestamp,
    ) -> ServiceFuture<()>;
    fn fence_graph(&self, request: PluginGraphFenceRequest, now: Timestamp) -> ServiceFuture<()>;
}

impl RuntimeServicePort for AppService {
    fn profile(&self) -> ServiceFuture<InstalledPluginProfile> {
        let service = self.clone();
        Box::pin(async move { service.get_installed_plugin_profile().await })
    }

    fn open_sources(
        &self,
        selected: Vec<PluginComponentSelection>,
    ) -> ServiceFuture<Vec<OpenedPluginComponentSource>> {
        let service = self.clone();
        Box::pin(async move { service.open_plugin_component_sources(selected).await })
    }

    fn reconcile_packages(&self, now: Timestamp) -> ServiceFuture<PluginPackageReconciliation> {
        let service = self.clone();
        Box::pin(async move { service.reconcile_plugin_packages(now).await })
    }

    fn retry_due(
        &self,
        operation_id: OperationId,
        request: DuePluginRetryRequest,
        now: Timestamp,
    ) -> ServiceFuture<()> {
        let service = self.clone();
        Box::pin(async move {
            service.retry_due_plugin(operation_id, request, now).await?;
            Ok(())
        })
    }

    fn complete_activation(
        &self,
        operation_id: OperationId,
        request: CompletePluginActivationRequest,
        now: Timestamp,
    ) -> ServiceFuture<()> {
        let service = self.clone();
        Box::pin(async move {
            service
                .complete_plugin_activation(operation_id, request, now)
                .await?;
            Ok(())
        })
    }

    fn cursor(&self, plugin_id: PluginId) -> ServiceFuture<junban_app::PluginEventCursor> {
        let service = self.clone();
        Box::pin(async move { service.get_plugin_cursor(plugin_id).await })
    }

    fn reserve_invocation(
        &self,
        request: ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> ServiceFuture<ReservedPluginInvocation> {
        let service = self.clone();
        Box::pin(async move { service.reserve_plugin_invocation(request, now).await })
    }

    fn complete_invocation(
        &self,
        operation_id: OperationId,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        now: Timestamp,
    ) -> ServiceFuture<CommittedPluginInvocation> {
        let service = self.clone();
        Box::pin(async move {
            service
                .complete_plugin_invocation(
                    operation_id,
                    plugin_id,
                    package_generation,
                    activation_epoch,
                    now,
                )
                .await
        })
    }

    fn record_failure(
        &self,
        operation_id: OperationId,
        request: RecordPluginAttemptFailureRequest,
        now: Timestamp,
    ) -> ServiceFuture<()> {
        let service = self.clone();
        Box::pin(async move {
            service
                .record_plugin_attempt_failure(operation_id, request, now)
                .await?;
            Ok(())
        })
    }

    fn fence_graph(&self, request: PluginGraphFenceRequest, now: Timestamp) -> ServiceFuture<()> {
        let service = self.clone();
        Box::pin(async move {
            service.fence_plugin_graph(request, now).await?;
            Ok(())
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CallbackDenial {
    Deferred,
    Cancelled,
}

type CallbackFuture =
    Pin<Box<dyn Future<Output = Result<HostCallReply, CallbackDenial>> + Send + 'static>>;

/// The sole Slice 2C callback seam. Production denies all concrete host calls;
/// Wave 2D can implement authorization without exposing frames or process data.
pub trait PluginCallbackDispatcher: Send + Sync {
    fn dispatch(&self, request: HostCallRequest) -> CallbackFuture;
}

struct DenyCallbacks;

impl PluginCallbackDispatcher for DenyCallbacks {
    fn dispatch(&self, _request: HostCallRequest) -> CallbackFuture {
        Box::pin(async { Err(CallbackDenial::Deferred) })
    }
}

struct ActorOwner {
    commands: mpsc::Sender<ActorCommand>,
    join: tokio::task::JoinHandle<()>,
}

enum ActorLifecycle {
    Running(ActorOwner),
    Stopping(watch::Receiver<Option<Result<(), PluginRuntimeError>>>),
}

/// Lazy owner. Construction does not inspect the executable, allocate a host
/// session, open a package source, spawn a process, or start an actor task.
pub struct PluginRuntimeSupervisor {
    service: Arc<dyn RuntimeServicePort>,
    launch_policy: PluginHostLaunchPolicy,
    callback_dispatcher: Arc<dyn PluginCallbackDispatcher>,
    actor: Arc<Mutex<Option<ActorLifecycle>>>,
    fenced: Arc<AtomicBool>,
}

impl PluginRuntimeSupervisor {
    pub fn new(service: AppService, launch_policy: PluginHostLaunchPolicy) -> Self {
        Self::from_parts(Arc::new(service), launch_policy, Arc::new(DenyCallbacks))
    }

    fn from_parts(
        service: Arc<dyn RuntimeServicePort>,
        launch_policy: PluginHostLaunchPolicy,
        callback_dispatcher: Arc<dyn PluginCallbackDispatcher>,
    ) -> Self {
        Self {
            service,
            launch_policy,
            callback_dispatcher,
            actor: Arc::new(Mutex::new(None)),
            fenced: Arc::new(AtomicBool::new(false)),
        }
    }

    pub async fn reconcile(&self) -> Result<PluginRuntimeSnapshot, PluginRuntimeError> {
        if self.fenced.load(Ordering::Acquire) {
            return Err(PluginRuntimeError::Fenced);
        }
        let plan = sanitize_profile(Arc::clone(&self.service), Timestamp::now()).await?;
        let existing = self.actor_sender()?;
        if plan.selected.is_empty() && existing.is_none() {
            return Ok(PluginRuntimeSnapshot::dormant());
        }
        let commands = match existing {
            Some(commands) => commands,
            None => self.start_actor()?,
        };
        let (reply, response) = oneshot::channel();
        commands
            .send(ActorCommand::Reconcile { plan, reply })
            .await
            .map_err(|_| PluginRuntimeError::Closed)?;
        let result = response.await.map_err(|_| PluginRuntimeError::Closed)?;
        self.clear_finished_actor();
        result
    }

    pub async fn invoke(
        &self,
        dispatch: PluginInvocationDispatch,
    ) -> Result<PluginInvocationHandle, PluginRuntimeError> {
        if self.fenced.load(Ordering::Acquire) {
            return Err(PluginRuntimeError::Fenced);
        }
        let commands = self.actor_sender()?.ok_or(PluginRuntimeError::Dormant)?;
        let invocation_id = dispatch.reservation.operation_id;
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let (terminal_sender, terminal) = oneshot::channel();
        let (accepted, acceptance) = oneshot::channel();
        commands
            .try_send(ActorCommand::Invoke {
                dispatch: Box::new(dispatch),
                ancestry: Vec::new(),
                service_depth: 0,
                cancel_requested: Arc::clone(&cancel_requested),
                terminal: Some(terminal_sender),
                nested_parent: None,
                accepted: Some(accepted),
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => PluginRuntimeError::Busy,
                mpsc::error::TrySendError::Closed(_) => PluginRuntimeError::Closed,
            })?;
        acceptance.await.map_err(|_| PluginRuntimeError::Closed)??;
        Ok(PluginInvocationHandle {
            invocation_id,
            terminal: Some(terminal),
            cancel_requested,
            commands: commands.downgrade(),
            completed: false,
        })
    }

    pub async fn snapshot(&self) -> Result<PluginRuntimeSnapshot, PluginRuntimeError> {
        if self.fenced.load(Ordering::Acquire) {
            return Ok(PluginRuntimeSnapshot {
                lifecycle: PluginRuntimeLifecycle::Fenced,
                ..PluginRuntimeSnapshot::dormant()
            });
        }
        let Some(commands) = self.actor_sender()? else {
            return Ok(PluginRuntimeSnapshot::dormant());
        };
        let (reply, response) = oneshot::channel();
        commands
            .send(ActorCommand::Snapshot { reply })
            .await
            .map_err(|_| PluginRuntimeError::Closed)?;
        response.await.map_err(|_| PluginRuntimeError::Closed)
    }

    /// Restore-facing drain. It validates the sanitized post-restore profile
    /// but intentionally does not start an actor or child.
    pub async fn restore_dormant(&self) -> Result<(), PluginRuntimeError> {
        self.stop_actor(StopReason::Restore).await?;
        self.service
            .profile()
            .await
            .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
        self.fenced.store(false, Ordering::Release);
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), PluginRuntimeError> {
        self.stop_actor(StopReason::Shutdown).await
    }

    fn actor_sender(&self) -> Result<Option<mpsc::Sender<ActorCommand>>, PluginRuntimeError> {
        let mut actor = self
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match actor.as_ref() {
            Some(ActorLifecycle::Running(owner)) if !owner.join.is_finished() => {
                Ok(Some(owner.commands.clone()))
            }
            Some(ActorLifecycle::Running(_)) => {
                actor.take();
                Ok(None)
            }
            Some(ActorLifecycle::Stopping(_)) => Err(PluginRuntimeError::Closed),
            None => Ok(None),
        }
    }

    fn start_actor(&self) -> Result<mpsc::Sender<ActorCommand>, PluginRuntimeError> {
        let mut actor = self
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match actor.as_ref() {
            Some(ActorLifecycle::Running(owner)) if !owner.join.is_finished() => {
                return Ok(owner.commands.clone());
            }
            Some(ActorLifecycle::Stopping(_)) => return Err(PluginRuntimeError::Closed),
            Some(ActorLifecycle::Running(_)) | None => {}
        }
        actor.take();
        let (commands, receiver) = mpsc::channel(ACTOR_COMMAND_CAPACITY);
        let state = RuntimeActor::new(
            Arc::clone(&self.service),
            self.launch_policy.clone(),
            Arc::clone(&self.callback_dispatcher),
            Arc::clone(&self.fenced),
            receiver,
        );
        let join = tokio::spawn(state.run());
        *actor = Some(ActorLifecycle::Running(ActorOwner {
            commands: commands.clone(),
            join,
        }));
        Ok(commands)
    }

    fn clear_finished_actor(&self) {
        let mut actor = self
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if matches!(actor.as_ref(), Some(ActorLifecycle::Running(owner)) if owner.join.is_finished())
        {
            actor.take();
        }
    }

    async fn stop_actor(&self, reason: StopReason) -> Result<(), PluginRuntimeError> {
        let mut completion = {
            let mut actor = self
                .actor
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match actor.take() {
                None => return Ok(()),
                Some(ActorLifecycle::Stopping(completion)) => {
                    *actor = Some(ActorLifecycle::Stopping(completion.clone()));
                    completion
                }
                Some(ActorLifecycle::Running(owner)) => {
                    let (completed, completion) = watch::channel(None);
                    *actor = Some(ActorLifecycle::Stopping(completion.clone()));
                    let lifecycle = Arc::clone(&self.actor);
                    tokio::spawn(async move {
                        let (reply, response) = oneshot::channel();
                        let sent = owner
                            .commands
                            .send(ActorCommand::Stop { reason, reply })
                            .await
                            .is_ok();
                        let result = if sent {
                            response.await.unwrap_or(Err(PluginRuntimeError::Closed))
                        } else {
                            Ok(())
                        };
                        let _ = owner.join.await;
                        {
                            let mut actor = lifecycle
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if matches!(actor.as_ref(), Some(ActorLifecycle::Stopping(_))) {
                                actor.take();
                            }
                        }
                        let _ = completed.send(Some(result));
                    });
                    completion
                }
            }
        };
        loop {
            if let Some(result) = *completion.borrow() {
                return result;
            }
            completion
                .changed()
                .await
                .map_err(|_| PluginRuntimeError::Closed)?;
        }
    }

    #[cfg(test)]
    fn for_test(
        service: Arc<dyn RuntimeServicePort>,
        launch_policy: PluginHostLaunchPolicy,
        callback_dispatcher: Arc<dyn PluginCallbackDispatcher>,
    ) -> Self {
        Self::from_parts(service, launch_policy, callback_dispatcher)
    }
}

impl Drop for PluginRuntimeSupervisor {
    fn drop(&mut self) {
        let lifecycle = self
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(ActorLifecycle::Running(owner)) = lifecycle {
            drop(owner.commands);
            // Invocation handles hold only weak wakeup senders, so closing the
            // supervisor owner always wakes the actor for bounded reap.
            drop(owner.join);
        }
    }
}

#[derive(Clone)]
struct RuntimePlan {
    profile: InstalledPluginProfile,
    selected: Vec<InstalledPlugin>,
}

async fn sanitize_profile(
    service: Arc<dyn RuntimeServicePort>,
    now: Timestamp,
) -> Result<RuntimePlan, PluginRuntimeError> {
    let mut profile = service
        .profile()
        .await
        .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
    let mut due: Vec<_> = profile
        .plugins
        .iter()
        .filter(|plugin| {
            plugin.desired_enabled
                && matches!(
                    plugin.runtime_state,
                    PluginRuntimeState::Degraded | PluginRuntimeState::Failed
                )
                && plugin.next_retry_at.is_some_and(|retry_at| retry_at <= now)
        })
        .cloned()
        .collect();
    due.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
    for plugin in due {
        service
            .retry_due(
                OperationId::new(),
                DuePluginRetryRequest {
                    plugin_id: plugin.plugin_id,
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected_runtime_state: plugin.runtime_state,
                    expected_next_retry_at: plugin.next_retry_at.expect("due retry has timestamp"),
                },
                now,
            )
            .await
            .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
    }
    if profile.plugins.iter().any(|plugin| {
        plugin.desired_enabled
            && matches!(
                plugin.runtime_state,
                PluginRuntimeState::Degraded | PluginRuntimeState::Failed
            )
            && plugin.next_retry_at.is_some_and(|retry_at| retry_at <= now)
    }) {
        profile = service
            .profile()
            .await
            .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
    }
    RuntimePlan::from_profile(profile)
}

impl RuntimePlan {
    fn from_profile(profile: InstalledPluginProfile) -> Result<Self, PluginRuntimeError> {
        let by_id: BTreeMap<_, _> = profile
            .plugins
            .iter()
            .map(|plugin| (plugin.plugin_id.as_str(), plugin))
            .collect();
        let candidates: BTreeSet<_> = profile
            .plugins
            .iter()
            .filter(|plugin| {
                plugin.desired_enabled
                    && matches!(
                        plugin.runtime_state,
                        PluginRuntimeState::Starting | PluginRuntimeState::Active
                    )
            })
            .map(|plugin| plugin.plugin_id.clone())
            .collect();
        let mut selected_ids = BTreeSet::new();
        for plugin_id in &profile.activation_order {
            let Some(plugin) = by_id.get(plugin_id.as_str()).copied() else {
                return Err(PluginRuntimeError::AuthorityRejected);
            };
            if candidates.contains(plugin_id)
                && plugin.manifest.dependencies.iter().all(|dependency| {
                    selected_ids
                        .iter()
                        .any(|selected: &PluginId| selected.as_str() == dependency.id)
                })
            {
                selected_ids.insert(plugin_id.clone());
            }
        }
        let selected = profile
            .activation_order
            .iter()
            .filter(|id| selected_ids.contains(*id))
            .map(|id| {
                by_id
                    .get(id.as_str())
                    .copied()
                    .cloned()
                    .ok_or(PluginRuntimeError::AuthorityRejected)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if selected.len() > junban_plugin_sdk::HOST_RUNTIME_ENTRIES_MAX {
            return Err(PluginRuntimeError::AuthorityRejected);
        }
        Ok(Self { profile, selected })
    }

    fn exact_graph_matches(&self, nodes: &BTreeMap<PluginId, LoadedNode>) -> bool {
        let configured: BTreeSet<_> = self
            .profile
            .plugins
            .iter()
            .filter(|plugin| {
                plugin.desired_enabled
                    && matches!(
                        plugin.runtime_state,
                        PluginRuntimeState::Starting
                            | PluginRuntimeState::Active
                            | PluginRuntimeState::Degraded
                            | PluginRuntimeState::Failed
                    )
            })
            .map(|plugin| plugin.plugin_id.clone())
            .collect();
        if configured.len() != nodes.len() {
            return false;
        }
        configured.into_iter().all(|plugin_id| {
            let current = nodes.get(&plugin_id);
            let target = self
                .profile
                .plugins
                .iter()
                .find(|plugin| plugin.plugin_id == plugin_id);
            matches!((current, target), (Some(current), Some(target))
                if current.plugin.package_generation == target.package_generation
                    && current.plugin.activation_epoch == target.activation_epoch)
        })
    }
}

#[derive(Clone, Copy)]
enum StopReason {
    Restore,
    Shutdown,
}

enum ActorCommand {
    Reconcile {
        plan: RuntimePlan,
        reply: oneshot::Sender<Result<PluginRuntimeSnapshot, PluginRuntimeError>>,
    },
    Invoke {
        dispatch: Box<PluginInvocationDispatch>,
        ancestry: Vec<PluginId>,
        service_depth: u8,
        cancel_requested: Arc<AtomicBool>,
        terminal: Option<oneshot::Sender<InvocationOutcome>>,
        nested_parent: Option<NestedParent>,
        accepted: Option<oneshot::Sender<Result<(), PluginRuntimeError>>>,
    },
    Cancel {
        invocation_id: OperationId,
    },
    Snapshot {
        reply: oneshot::Sender<PluginRuntimeSnapshot>,
    },
    Stop {
        reason: StopReason,
        reply: oneshot::Sender<Result<(), PluginRuntimeError>>,
    },
}

struct DriverOwner {
    commands: PluginHostRuntimeDriverHandle,
    events: mpsc::Receiver<PluginHostRuntimeEvent>,
    pump: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
struct LoadedNode {
    plugin: InstalledPlugin,
    load_frame: ParentFrame,
    admitting: bool,
}

struct PendingBody {
    frame: ChildFrame,
    plugin_id: PluginId,
    invocation_id: OperationId,
}

struct NestedParent {
    invocation_id: OperationId,
    callback: CallbackFence,
}

enum InvocationPhase {
    Reserving,
    Running,
    Cancelling,
    Completing(InvocationOutcome),
    CompletingFailure {
        outcome: InvocationOutcome,
        cause: PluginAttemptFailureCause,
    },
    RecordingFailure(Option<InvocationOutcome>),
}

struct InvocationRecord {
    operation_id: OperationId,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    fence: AuthorityFence,
    kind: InvocationKind,
    invoke_frame: ParentFrame,
    body: Vec<u8>,
    phase: InvocationPhase,
    ancestry: Vec<PluginId>,
    service_depth: u8,
    next_callback_id: u32,
    expected_callback: Option<ExpectedCallback>,
    deadline: Option<tokio::time::Instant>,
    awaiting_child_terminal: bool,
    cancel_requested: Arc<AtomicBool>,
    terminal: Option<oneshot::Sender<InvocationOutcome>>,
    nested_parent: Option<NestedParent>,
    durable: bool,
}

struct ExpectedCallback {
    frame: ChildFrame,
    callback: CallbackFence,
    kind: HostCallKind,
    task: Option<tokio::task::AbortHandle>,
}

enum InternalEvent {
    Reservation {
        invocation_id: OperationId,
        result: Result<ReservedPluginInvocation, AppError>,
    },
    Completion {
        invocation_id: OperationId,
        result: Result<CommittedPluginInvocation, AppError>,
    },
    CancellationCompletion {
        invocation_id: OperationId,
        result: Result<CommittedPluginInvocation, AppError>,
    },
    FailureRecorded {
        invocation_id: OperationId,
        result: Result<(), AppError>,
    },
    Callback {
        invocation_id: OperationId,
        callback: CallbackFence,
        kind: HostCallKind,
        result: Result<HostCallReply, CallbackDenial>,
    },
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CancelledReservationPhase {
    AwaitingReservation,
    Completing,
}

struct CancelledReservation {
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    phase: CancelledReservationPhase,
}

struct PendingReconfigure {
    plan: RuntimePlan,
    reply: oneshot::Sender<Result<PluginRuntimeSnapshot, PluginRuntimeError>>,
}

struct PendingStop {
    reason: StopReason,
    reply: oneshot::Sender<Result<(), PluginRuntimeError>>,
}

enum FenceCompletion {
    None,
    Reconfigure(oneshot::Sender<Result<PluginRuntimeSnapshot, PluginRuntimeError>>),
    Stop(oneshot::Sender<Result<(), PluginRuntimeError>>),
}

enum DrainPurpose {
    Reconfigure(PendingReconfigure),
    Stop(PendingStop),
    DetachedStop,
    Fence {
        trigger: Option<(PluginId, PluginGraphFenceCause)>,
        graph: Vec<InstalledPlugin>,
        host_session_id: String,
        completion: FenceCompletion,
    },
    Fenced,
}

struct DrainState {
    purpose: DrainPurpose,
    deadline: tokio::time::Instant,
}

struct RuntimeActor {
    service: Arc<dyn RuntimeServicePort>,
    launch_policy: PluginHostLaunchPolicy,
    callback_dispatcher: Arc<dyn PluginCallbackDispatcher>,
    fenced: Arc<AtomicBool>,
    commands: mpsc::Receiver<ActorCommand>,
    internal_sender: mpsc::Sender<InternalEvent>,
    internal: mpsc::Receiver<InternalEvent>,
    lifecycle: PluginRuntimeLifecycle,
    nodes: BTreeMap<PluginId, LoadedNode>,
    activation_order: Vec<PluginId>,
    host_session_id: Option<String>,
    driver: Option<DriverOwner>,
    pending_body: Option<PendingBody>,
    invocations: HashMap<OperationId, InvocationRecord>,
    cancelled_reservations: HashMap<OperationId, CancelledReservation>,
    background: tokio::task::JoinSet<()>,
    drain: Option<DrainState>,
    exit_when_idle: bool,
}

impl RuntimeActor {
    fn new(
        service: Arc<dyn RuntimeServicePort>,
        launch_policy: PluginHostLaunchPolicy,
        callback_dispatcher: Arc<dyn PluginCallbackDispatcher>,
        fenced: Arc<AtomicBool>,
        commands: mpsc::Receiver<ActorCommand>,
    ) -> Self {
        let (internal_sender, internal) = mpsc::channel(INTERNAL_EVENT_CAPACITY);
        Self {
            service,
            launch_policy,
            callback_dispatcher,
            fenced,
            commands,
            internal_sender,
            internal,
            lifecycle: PluginRuntimeLifecycle::Dormant,
            nodes: BTreeMap::new(),
            activation_order: Vec::new(),
            host_session_id: None,
            driver: None,
            pending_body: None,
            invocations: HashMap::new(),
            cancelled_reservations: HashMap::new(),
            background: tokio::task::JoinSet::new(),
            drain: None,
            exit_when_idle: false,
        }
    }

    async fn run(mut self) {
        loop {
            self.scan_cancellations();
            self.scan_watchdogs().await;
            if self.exit_when_idle
                && self.driver.is_none()
                && self.invocations.is_empty()
                && self.cancelled_reservations.is_empty()
                && self.background.is_empty()
            {
                break;
            }
            let invocation_deadline = self
                .invocations
                .values()
                .filter_map(|record| record.deadline)
                .min();
            let drain_deadline = self.drain.as_ref().map(|drain| drain.deadline);
            let next_deadline = match (invocation_deadline, drain_deadline) {
                (Some(left), Some(right)) => Some(left.min(right)),
                (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
                (None, None) => None,
            };

            if let Some(deadline) = next_deadline {
                tokio::select! {
                    command = self.commands.recv() => {
                        if !self.handle_command_option(command).await { break; }
                    }
                    event = async {
                        match self.driver.as_mut() {
                            Some(driver) => driver.events.recv().await,
                            None => std::future::pending().await,
                        }
                    } => {
                        if let Some(event) = event { self.handle_driver_event(event).await; }
                    }
                    event = self.internal.recv() => {
                        if let Some(event) = event { self.handle_internal(event).await; }
                    }
                    _ = async {
                        if self.background.is_empty() {
                            std::future::pending::<()>().await;
                        } else {
                            let _ = self.background.join_next().await;
                        }
                    } => {}
                    () = tokio::time::sleep_until(deadline) => {}
                }
            } else {
                tokio::select! {
                    command = self.commands.recv() => {
                        if !self.handle_command_option(command).await { break; }
                    }
                    event = async {
                        match self.driver.as_mut() {
                            Some(driver) => driver.events.recv().await,
                            None => std::future::pending().await,
                        }
                    } => {
                        if let Some(event) = event { self.handle_driver_event(event).await; }
                    }
                    event = self.internal.recv() => {
                        if let Some(event) = event { self.handle_internal(event).await; }
                    }
                    _ = async {
                        if self.background.is_empty() {
                            std::future::pending::<()>().await;
                        } else {
                            let _ = self.background.join_next().await;
                        }
                    } => {}
                }
            }
        }

        if self.driver.is_some() {
            self.begin_stop_without_reply().await;
            while self.driver.is_some() {
                let event = {
                    let driver = self.driver.as_mut().expect("driver remains");
                    driver.events.recv().await
                };
                match event {
                    Some(event) => self.handle_driver_event(event).await,
                    None => break,
                }
            }
        }
        self.lifecycle = PluginRuntimeLifecycle::Shutdown;
    }

    async fn handle_command_option(&mut self, command: Option<ActorCommand>) -> bool {
        let Some(command) = command else {
            self.begin_stop_without_reply().await;
            self.exit_when_idle = true;
            return self.driver.is_some();
        };
        self.handle_command(command).await;
        true
    }

    async fn handle_command(&mut self, command: ActorCommand) {
        match command {
            ActorCommand::Reconcile { plan, reply } => self.handle_reconcile(plan, reply).await,
            ActorCommand::Invoke {
                dispatch,
                ancestry,
                service_depth,
                cancel_requested,
                terminal,
                nested_parent,
                accepted,
            } => self.handle_invoke(
                *dispatch,
                ancestry,
                service_depth,
                cancel_requested,
                terminal,
                nested_parent,
                accepted,
            ),
            ActorCommand::Cancel { invocation_id } => self.cancel_invocation(invocation_id),
            ActorCommand::Snapshot { reply } => {
                let _ = reply.send(self.snapshot());
            }
            ActorCommand::Stop { reason, reply } => self.handle_stop(reason, reply).await,
        }
    }

    async fn handle_reconcile(
        &mut self,
        plan: RuntimePlan,
        reply: oneshot::Sender<Result<PluginRuntimeSnapshot, PluginRuntimeError>>,
    ) {
        if self.fenced.load(Ordering::Acquire) || self.lifecycle == PluginRuntimeLifecycle::Fenced {
            let _ = reply.send(Err(PluginRuntimeError::Fenced));
            return;
        }
        if self.drain.is_some() || self.lifecycle == PluginRuntimeLifecycle::Draining {
            let _ = reply.send(Err(PluginRuntimeError::Busy));
            return;
        }
        if self.driver.is_some() && plan.exact_graph_matches(&self.nodes) {
            match self.complete_ready_activations(&plan).await {
                Ok(current) => {
                    self.refresh_admission(&current);
                    let _ = reply.send(Ok(self.snapshot()));
                }
                Err(error) => {
                    self.enter_fenced();
                    self.begin_drain(DrainPurpose::Fenced).await;
                    let _ = reply.send(Err(error));
                }
            }
            return;
        }
        if self.driver.is_some() {
            self.begin_drain(DrainPurpose::Reconfigure(PendingReconfigure {
                plan,
                reply,
            }))
            .await;
            return;
        }
        self.launch(plan, reply).await;
    }

    async fn launch(
        &mut self,
        plan: RuntimePlan,
        reply: oneshot::Sender<Result<PluginRuntimeSnapshot, PluginRuntimeError>>,
    ) {
        if plan.selected.is_empty() {
            self.lifecycle = PluginRuntimeLifecycle::Dormant;
            self.exit_when_idle = true;
            let _ = reply.send(Ok(self.snapshot()));
            return;
        }
        self.lifecycle = PluginRuntimeLifecycle::Loading;
        let mut selected: Vec<_> = plan
            .selected
            .iter()
            .map(|plugin| PluginComponentSelection {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
            })
            .collect();
        selected.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        let sources = match self.service.open_sources(selected).await {
            Ok(sources) => sources,
            Err(_) => {
                let reconciliation = self.service.reconcile_packages(Timestamp::now()).await;
                self.lifecycle = PluginRuntimeLifecycle::Dormant;
                self.exit_when_idle = true;
                let result = if reconciliation.is_ok() {
                    Err(PluginRuntimeError::AuthorityRejected)
                } else {
                    self.enter_fenced();
                    Err(PluginRuntimeError::Fenced)
                };
                let _ = reply.send(result);
                return;
            }
        };
        let policy = self.launch_policy.clone();
        let launch_plugins = plan.selected.clone();
        let launched =
            tokio::task::spawn_blocking(move || launch_process(policy, launch_plugins, sources))
                .await
                .map_err(|_| LaunchFailure::worker());
        let launched = match launched {
            Ok(Ok(launched)) => launched,
            Ok(Err(failure)) | Err(failure) => {
                if failure.package_fault {
                    let _ = self.service.reconcile_packages(Timestamp::now()).await;
                }
                self.handle_launch_failure(&plan, failure).await;
                let _ = reply.send(Err(if self.fenced.load(Ordering::Acquire) {
                    PluginRuntimeError::Fenced
                } else {
                    PluginRuntimeError::SessionLost
                }));
                return;
            }
        };
        self.install_launched(launched);
        match self.complete_ready_activations(&plan).await {
            Ok(current) => {
                self.refresh_admission(&current);
                let _ = reply.send(Ok(self.snapshot()));
            }
            Err(error) => {
                self.enter_fenced();
                self.begin_drain(DrainPurpose::Fenced).await;
                let _ = reply.send(Err(error));
            }
        }
    }

    fn install_launched(&mut self, launched: LaunchedProcess) {
        let (event_sender, events) = mpsc::channel(DRIVER_EVENT_CAPACITY);
        let pump = tokio::task::spawn_blocking(move || {
            while let Ok(event) = launched.events.recv() {
                let terminal = matches!(event, PluginHostRuntimeEvent::Closed(_));
                if event_sender.blocking_send(event).is_err() || terminal {
                    break;
                }
            }
        });
        self.host_session_id = Some(launched.host_session_id);
        self.activation_order = launched
            .nodes
            .iter()
            .map(|node| node.plugin.plugin_id.clone())
            .collect();
        self.nodes = launched
            .nodes
            .into_iter()
            .map(|node| (node.plugin.plugin_id.clone(), node))
            .collect();
        self.driver = Some(DriverOwner {
            commands: launched.commands,
            events,
            pump,
        });
        self.lifecycle = PluginRuntimeLifecycle::Running;
    }

    async fn handle_launch_failure(&mut self, plan: &RuntimePlan, failure: LaunchFailure) {
        self.nodes.clear();
        self.activation_order.clear();
        self.host_session_id = None;
        self.exit_when_idle = true;
        let fenced = match failure.host_session_id {
            Some(host_session_id) => {
                self.fence_current_graph(
                    &plan.selected,
                    failure
                        .failing_plugin
                        .map(|plugin_id| (plugin_id, failure.cause)),
                    host_session_id,
                )
                .await
            }
            None => false,
        };
        if fenced {
            self.lifecycle = PluginRuntimeLifecycle::Dormant;
        } else {
            self.enter_fenced();
        }
    }

    async fn complete_ready_activations(
        &mut self,
        plan: &RuntimePlan,
    ) -> Result<InstalledPluginProfile, PluginRuntimeError> {
        for plugin in &plan.selected {
            if plugin.runtime_state != PluginRuntimeState::Starting {
                continue;
            }
            let cursor = self
                .service
                .cursor(plugin.plugin_id.clone())
                .await
                .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
            if cursor.resync_required {
                continue;
            }
            self.service
                .complete_activation(
                    OperationId::new(),
                    CompletePluginActivationRequest {
                        plugin_id: plugin.plugin_id.clone(),
                        package_generation: plugin.package_generation,
                        activation_epoch: plugin.activation_epoch,
                    },
                    Timestamp::now(),
                )
                .await
                .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
        }
        let current = self
            .service
            .profile()
            .await
            .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
        for node in self.nodes.values_mut() {
            let Some(plugin) = current.plugins.iter().find(|plugin| {
                plugin.plugin_id == node.plugin.plugin_id
                    && plugin.package_generation == node.plugin.package_generation
                    && plugin.activation_epoch == node.plugin.activation_epoch
            }) else {
                return Err(PluginRuntimeError::AuthorityRejected);
            };
            if !plugin.desired_enabled
                || !matches!(
                    plugin.runtime_state,
                    PluginRuntimeState::Starting
                        | PluginRuntimeState::Active
                        | PluginRuntimeState::Degraded
                        | PluginRuntimeState::Failed
                )
            {
                return Err(PluginRuntimeError::AuthorityRejected);
            }
            node.plugin = plugin.clone();
        }
        Ok(current)
    }

    fn refresh_admission(&mut self, profile: &InstalledPluginProfile) {
        for node in self.nodes.values_mut() {
            if let Some(plugin) = profile
                .plugins
                .iter()
                .find(|plugin| plugin.plugin_id == node.plugin.plugin_id)
            {
                node.plugin = plugin.clone();
            }
            node.admitting = node.plugin.desired_enabled
                && node.plugin.runtime_state == PluginRuntimeState::Active;
        }
        self.lifecycle = PluginRuntimeLifecycle::Running;
    }

    #[allow(clippy::too_many_arguments)]
    fn handle_invoke(
        &mut self,
        dispatch: PluginInvocationDispatch,
        mut ancestry: Vec<PluginId>,
        service_depth: u8,
        cancel_requested: Arc<AtomicBool>,
        terminal: Option<oneshot::Sender<InvocationOutcome>>,
        nested_parent: Option<NestedParent>,
        accepted: Option<oneshot::Sender<Result<(), PluginRuntimeError>>>,
    ) {
        let reject = |error, accepted: Option<oneshot::Sender<_>>| {
            if let Some(accepted) = accepted {
                let _ = accepted.send(Err(error));
            }
        };
        let plugin_id = dispatch.reservation.plugin_id.clone();
        let operation_id = dispatch.reservation.operation_id;
        if self.invocations.contains_key(&operation_id)
            || self.cancelled_reservations.contains_key(&operation_id)
        {
            reject(PluginRuntimeError::AuthorityRejected, accepted);
            return;
        }
        let resync = dispatch.request.kind() == InvocationKind::Resync;
        if let Err(error) =
            self.check_invocation_admission(&plugin_id, resync, &ancestry, service_depth)
        {
            reject(error, accepted);
            return;
        }
        let node = self
            .nodes
            .get(&plugin_id)
            .expect("admission checked the selected node");
        if nested_parent.is_none() && !dispatch_matches_hook(&dispatch) {
            reject(PluginRuntimeError::AuthorityRejected, accepted);
            return;
        }
        let Some(session_id) = self.host_session_id.clone() else {
            reject(PluginRuntimeError::Dormant, accepted);
            return;
        };
        let fence = AuthorityFence {
            plugin_id: plugin_id.to_string(),
            package_generation: node.plugin.package_generation,
            activation_epoch: node.plugin.activation_epoch,
            host_session_id: session_id,
            invocation_id: dispatch.reservation.operation_id.to_string(),
        };
        let permission_hash = match &node.load_frame {
            ParentFrame::Load {
                permission_hash, ..
            } => permission_hash.clone(),
            _ => {
                reject(PluginRuntimeError::AuthorityRejected, accepted);
                return;
            }
        };
        let message = match dispatch
            .request
            .clone()
            .into_parent_message(fence.clone(), permission_hash)
        {
            Ok(message) => message,
            Err(_) => {
                reject(PluginRuntimeError::AuthorityRejected, accepted);
                return;
            }
        };
        let (invoke_frame, body) = message.into_parts();
        let request_hash_matches = matches!(
            &invoke_frame,
            ParentFrame::Invoke { request_sha256, .. }
                if request_sha256 == dispatch.reservation.request_sha256.as_str()
        );
        if !request_hash_matches
            || dispatch.reservation.package_generation != node.plugin.package_generation
            || dispatch.reservation.activation_epoch != node.plugin.activation_epoch
        {
            reject(PluginRuntimeError::AuthorityRejected, accepted);
            return;
        }
        ancestry.push(plugin_id.clone());
        let durable = nested_parent.is_none();
        let record = InvocationRecord {
            operation_id,
            plugin_id,
            package_generation: node.plugin.package_generation,
            activation_epoch: node.plugin.activation_epoch,
            fence,
            kind: dispatch.request.kind(),
            invoke_frame,
            body,
            phase: if durable {
                InvocationPhase::Reserving
            } else {
                InvocationPhase::Running
            },
            ancestry,
            service_depth,
            next_callback_id: 1,
            expected_callback: None,
            deadline: None,
            awaiting_child_terminal: false,
            cancel_requested,
            terminal,
            nested_parent,
            durable,
        };
        match self.invocations.entry(operation_id) {
            Entry::Vacant(entry) => {
                entry.insert(record);
            }
            Entry::Occupied(_) => {
                reject(PluginRuntimeError::AuthorityRejected, accepted);
                return;
            }
        }
        if let Some(accepted) = accepted {
            let _ = accepted.send(Ok(()));
        }
        if durable {
            let service = Arc::clone(&self.service);
            let sender = self.internal_sender.clone();
            let request = dispatch.reservation;
            self.background.spawn(async move {
                let result = service.reserve_invocation(request, Timestamp::now()).await;
                let _ = sender
                    .send(InternalEvent::Reservation {
                        invocation_id: operation_id,
                        result,
                    })
                    .await;
            });
        } else {
            self.send_invocation(operation_id);
        }
    }

    fn send_invocation(&mut self, invocation_id: OperationId) {
        let Some(record) = self.invocations.get_mut(&invocation_id) else {
            return;
        };
        if record.cancel_requested.load(Ordering::Acquire) {
            self.cancel_invocation(invocation_id);
            return;
        }
        let message = ParentMessage::new(record.invoke_frame.clone(), record.body.clone());
        let timeout_ms = RuntimeLimits::for_profile(
            self.nodes
                .get(&record.plugin_id)
                .map_or(junban_plugin_sdk::RuntimeProfile::Rust, |node| {
                    node.plugin.manifest.runtime_profile
                }),
        )
        .invocation_timeout_ms(record.kind);
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(u64::from(timeout_ms)))
            .unwrap_or_else(Instant::now);
        let result = self
            .driver
            .as_ref()
            .ok_or(PluginHostProcessError::Closed)
            .and_then(|driver| driver.commands.send(message, deadline));
        if result.is_err() {
            self.begin_graph_fatal(None);
            return;
        }
        record.phase = InvocationPhase::Running;
        record.deadline =
            Some(tokio::time::Instant::now() + Duration::from_millis(u64::from(timeout_ms)));
    }

    fn scan_cancellations(&mut self) {
        let cancelled: Vec<_> = self
            .invocations
            .iter()
            .filter(|(_, record)| record.cancel_requested.load(Ordering::Acquire))
            .map(|(id, _)| *id)
            .collect();
        for invocation_id in cancelled {
            self.cancel_invocation(invocation_id);
        }
    }

    fn cancel_invocation(&mut self, invocation_id: OperationId) {
        let Some(phase) = self
            .invocations
            .get(&invocation_id)
            .map(|record| &record.phase)
        else {
            return;
        };
        if matches!(phase, InvocationPhase::Cancelling) {
            return;
        }
        if matches!(
            phase,
            InvocationPhase::Completing(_)
                | InvocationPhase::CompletingFailure { .. }
                | InvocationPhase::RecordingFailure(_)
        ) {
            return;
        }
        if matches!(phase, InvocationPhase::Reserving) {
            let mut record = self
                .invocations
                .remove(&invocation_id)
                .expect("invocation remains owned");
            if let Some(expected) = record.expected_callback.as_mut()
                && let Some(task) = expected.task.take()
            {
                task.abort();
            }
            if record.durable {
                self.cancelled_reservations.insert(
                    record.operation_id,
                    CancelledReservation {
                        plugin_id: record.plugin_id.clone(),
                        package_generation: record.package_generation,
                        activation_epoch: record.activation_epoch,
                        phase: CancelledReservationPhase::AwaitingReservation,
                    },
                );
            }
            self.publish_terminal(&mut record, InvocationOutcome::Cancelled);
            return;
        }

        let completion = {
            let Some(record) = self.invocations.get_mut(&invocation_id) else {
                return;
            };
            if let Some(expected) = record.expected_callback.as_mut()
                && let Some(task) = expected.task.take()
            {
                task.abort();
            }
            let cancel = ParentMessage::new(
                ParentFrame::Cancel {
                    fence: record.fence.clone(),
                },
                Vec::new(),
            );
            let send_result = self
                .driver
                .as_ref()
                .ok_or(PluginHostProcessError::Closed)
                .and_then(|driver| {
                    driver.commands.send(
                        cancel,
                        Instant::now()
                            .checked_add(DRAIN_DEADLINE)
                            .unwrap_or_else(Instant::now),
                    )
                });
            if send_result.is_err() {
                self.begin_graph_fatal(None);
                return;
            }
            record.phase = InvocationPhase::Cancelling;
            record.awaiting_child_terminal = true;
            record.deadline = Some(tokio::time::Instant::now() + DRAIN_DEADLINE);
            record.durable.then(|| {
                (
                    record.operation_id,
                    record.plugin_id.clone(),
                    record.package_generation,
                    record.activation_epoch,
                )
            })
        };
        if let Some((operation_id, plugin_id, generation, epoch)) = completion {
            self.spawn_cancellation_completion(operation_id, plugin_id, generation, epoch);
        }
        if let Some(mut record) = self.invocations.remove(&invocation_id) {
            self.publish_terminal(&mut record, InvocationOutcome::Cancelled);
            self.invocations.insert(invocation_id, record);
        }
    }

    fn spawn_cancellation_completion(
        &mut self,
        operation_id: OperationId,
        plugin_id: PluginId,
        generation: u64,
        epoch: u64,
    ) {
        let should_spawn = match self.cancelled_reservations.entry(operation_id) {
            Entry::Vacant(entry) => {
                entry.insert(CancelledReservation {
                    plugin_id: plugin_id.clone(),
                    package_generation: generation,
                    activation_epoch: epoch,
                    phase: CancelledReservationPhase::Completing,
                });
                true
            }
            Entry::Occupied(mut entry) => {
                let pending = entry.get_mut();
                if pending.plugin_id != plugin_id
                    || pending.package_generation != generation
                    || pending.activation_epoch != epoch
                {
                    self.begin_graph_fatal(None);
                    return;
                }
                if pending.phase == CancelledReservationPhase::Completing {
                    false
                } else {
                    pending.phase = CancelledReservationPhase::Completing;
                    true
                }
            }
        };
        if !should_spawn {
            return;
        }
        let service = Arc::clone(&self.service);
        let sender = self.internal_sender.clone();
        self.background.spawn(async move {
            let result = service
                .complete_invocation(operation_id, plugin_id, generation, epoch, Timestamp::now())
                .await;
            let _ = sender
                .send(InternalEvent::CancellationCompletion {
                    invocation_id: operation_id,
                    result,
                })
                .await;
        });
    }

    async fn scan_watchdogs(&mut self) {
        let now = tokio::time::Instant::now();
        let expired: Vec<_> = self
            .invocations
            .iter()
            .filter(|(_, record)| record.deadline.is_some_and(|deadline| deadline <= now))
            .map(|(id, record)| {
                (
                    *id,
                    record.awaiting_child_terminal
                        || matches!(record.phase, InvocationPhase::Cancelling),
                )
            })
            .collect();
        for (invocation_id, cancelling) in expired {
            if cancelling {
                let trigger = self
                    .invocations
                    .get(&invocation_id)
                    .map(|record| (record.plugin_id.clone(), PluginGraphFenceCause::ChildFatal));
                self.begin_graph_fatal(trigger);
            } else {
                self.timeout_plugin_invocation(invocation_id);
            }
        }
        if self
            .drain
            .as_ref()
            .is_some_and(|drain| drain.deadline <= now)
        {
            self.begin_graph_fatal(None);
        }
    }

    async fn handle_internal(&mut self, event: InternalEvent) {
        match event {
            InternalEvent::Reservation {
                invocation_id,
                result,
            } => self.handle_reservation(invocation_id, result),
            InternalEvent::Completion {
                invocation_id,
                result,
            } => self.handle_completion(invocation_id, result).await,
            InternalEvent::CancellationCompletion {
                invocation_id,
                result,
            } => {
                self.cancelled_reservations.remove(&invocation_id);
                if result.is_err() {
                    self.enter_fenced();
                    self.begin_drain(DrainPurpose::Fenced).await;
                }
            }
            InternalEvent::FailureRecorded {
                invocation_id,
                result,
            } => {
                self.handle_failure_recorded(invocation_id, result).await;
            }
            InternalEvent::Callback {
                invocation_id,
                callback,
                kind,
                result,
            } => self.handle_callback_result(invocation_id, callback, kind, result),
        }
    }

    fn handle_reservation(
        &mut self,
        invocation_id: OperationId,
        result: Result<ReservedPluginInvocation, AppError>,
    ) {
        if let Some(cancelled) = self.cancelled_reservations.get(&invocation_id) {
            if cancelled.phase != CancelledReservationPhase::AwaitingReservation {
                self.begin_graph_fatal(None);
                return;
            }
            let authority = (
                cancelled.plugin_id.clone(),
                cancelled.package_generation,
                cancelled.activation_epoch,
            );
            match result {
                Ok(ReservedPluginInvocation::Reserved(_))
                | Ok(ReservedPluginInvocation::InFlightReplay(_)) => {
                    self.spawn_cancellation_completion(
                        invocation_id,
                        authority.0,
                        authority.1,
                        authority.2,
                    );
                }
                Ok(ReservedPluginInvocation::TerminalReplay(_)) | Err(_) => {
                    self.cancelled_reservations.remove(&invocation_id);
                }
            }
            return;
        }
        let cancelled = self
            .invocations
            .get(&invocation_id)
            .is_some_and(|record| record.cancel_requested.load(Ordering::Acquire));
        if cancelled {
            self.cancel_invocation(invocation_id);
            return;
        }
        match result {
            Ok(ReservedPluginInvocation::TerminalReplay(committed)) => {
                if let Some(mut record) = self.invocations.remove(&invocation_id) {
                    self.publish_terminal(&mut record, InvocationOutcome::Replayed(committed));
                }
            }
            Ok(ReservedPluginInvocation::Reserved(_))
            | Ok(ReservedPluginInvocation::InFlightReplay(_)) => {
                self.send_invocation(invocation_id);
            }
            Err(_) => self.finish_with_failure(invocation_id, InvocationFailure::AuthorityRejected),
        }
    }

    async fn handle_completion(
        &mut self,
        invocation_id: OperationId,
        result: Result<CommittedPluginInvocation, AppError>,
    ) {
        let Some(mut record) = self.invocations.remove(&invocation_id) else {
            return;
        };
        if result.is_err() {
            if matches!(record.phase, InvocationPhase::Completing(_)) {
                self.publish_terminal(
                    &mut record,
                    InvocationOutcome::Failed(InvocationFailure::AuthorityRejected),
                );
            }
            // A failed durable completion keeps its invocation row and exact
            // operation identity for startup recovery. Do not publish the
            // plugin-local terminal that failed to become durable.
            self.enter_fenced();
            self.begin_drain(DrainPurpose::Fenced).await;
            return;
        }
        match std::mem::replace(&mut record.phase, InvocationPhase::Running) {
            InvocationPhase::Completing(outcome) => {
                self.publish_terminal(&mut record, outcome);
            }
            InvocationPhase::CompletingFailure { outcome, cause } => {
                self.publish_terminal(&mut record, outcome);
                let plugin_id = record.plugin_id.clone();
                let package_generation = record.package_generation;
                let activation_epoch = record.activation_epoch;
                record.phase = InvocationPhase::RecordingFailure(None);
                self.invocations.insert(invocation_id, record);
                self.spawn_failure_record(
                    invocation_id,
                    plugin_id,
                    package_generation,
                    activation_epoch,
                    cause,
                );
            }
            _ => {
                self.publish_terminal(
                    &mut record,
                    InvocationOutcome::Failed(InvocationFailure::AuthorityRejected),
                );
            }
        }
    }

    async fn handle_failure_recorded(
        &mut self,
        invocation_id: OperationId,
        result: Result<(), AppError>,
    ) {
        let Some(mut record) = self.invocations.remove(&invocation_id) else {
            return;
        };
        if result.is_err() {
            self.publish_terminal(
                &mut record,
                InvocationOutcome::Failed(InvocationFailure::SessionLost),
            );
            self.enter_fenced();
            self.begin_drain(DrainPurpose::Fenced).await;
            return;
        }
        let pending_outcome = match std::mem::replace(&mut record.phase, InvocationPhase::Running) {
            InvocationPhase::RecordingFailure(outcome) => outcome,
            _ => {
                self.invocations.insert(invocation_id, record);
                self.enter_fenced();
                self.begin_drain(DrainPurpose::Fenced).await;
                return;
            }
        };
        let profile = self.service.profile().await;
        let refreshed = profile.ok().and_then(|profile| {
            profile.plugins.into_iter().find(|plugin| {
                plugin.plugin_id == record.plugin_id
                    && plugin.package_generation == record.package_generation
                    && plugin.activation_epoch == record.activation_epoch
                    && plugin.runtime_state == PluginRuntimeState::Degraded
            })
        });
        let Some(plugin) = refreshed else {
            self.publish_terminal(
                &mut record,
                InvocationOutcome::Failed(InvocationFailure::SessionLost),
            );
            self.enter_fenced();
            self.begin_drain(DrainPurpose::Fenced).await;
            return;
        };
        if let Some(node) = self.nodes.get_mut(&record.plugin_id) {
            node.plugin = plugin;
            node.admitting = false;
        }
        if let Some(outcome) = pending_outcome {
            self.publish_terminal(&mut record, outcome);
        }
        if record.awaiting_child_terminal {
            record.phase = InvocationPhase::Cancelling;
            self.invocations.insert(invocation_id, record);
        }
    }

    fn handle_callback_result(
        &mut self,
        invocation_id: OperationId,
        callback: CallbackFence,
        kind: HostCallKind,
        result: Result<HostCallReply, CallbackDenial>,
    ) {
        let Some(record) = self.invocations.get_mut(&invocation_id) else {
            return;
        };
        let plugin_id = record.plugin_id.clone();
        let fence = record.fence.clone();
        let next_callback_id = record.next_callback_id.checked_add(1);
        let expected = record.expected_callback.take();
        let Some(expected) = expected else {
            self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
            return;
        };
        if expected.callback != callback || expected.kind != kind {
            self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
            return;
        }
        let reply = match result {
            Ok(reply) if reply.kind() == kind => reply,
            Ok(_) => {
                self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
                return;
            }
            Err(_) => denied_host_reply(kind),
        };
        let message = match reply.into_parent_message(callback) {
            Ok(message) => message,
            Err(_) => {
                self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
                return;
            }
        };
        if validate_capability_reply(&expected.frame, message.frame(), &fence).is_err() {
            self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
            return;
        }
        let Some(next_callback_id) = next_callback_id else {
            self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
            return;
        };
        let (frame, body) = message.into_parts();
        let result = self
            .driver
            .as_ref()
            .ok_or(PluginHostProcessError::Closed)
            .and_then(|driver| {
                driver.commands.send(
                    ParentMessage::new(frame, body),
                    Instant::now()
                        .checked_add(DRAIN_DEADLINE)
                        .unwrap_or_else(Instant::now),
                )
            });
        if result.is_err() {
            self.begin_graph_fatal(None);
            return;
        }
        if let Some(record) = self.invocations.get_mut(&invocation_id) {
            record.next_callback_id = next_callback_id;
        }
    }

    async fn handle_driver_event(&mut self, event: PluginHostRuntimeEvent) {
        match event {
            PluginHostRuntimeEvent::Header {
                frame,
                pending_body,
            } => self.handle_header(frame, pending_body),
            PluginHostRuntimeEvent::Body { frame, body } => self.handle_body(frame, body),
            PluginHostRuntimeEvent::Closed(result) => self.handle_driver_closed(result).await,
        }
    }

    fn handle_header(
        &mut self,
        frame: ChildFrame,
        pending_body: Option<PendingPluginHostBodyToken>,
    ) {
        if self.pending_body.is_some() {
            self.begin_graph_fatal(
                frame_plugin_id(&frame).map(|id| (id, PluginGraphFenceCause::ChildFatal)),
            );
            return;
        }
        match &frame {
            ChildFrame::CapabilityRequest { callback, kind, .. } => {
                let Some((invocation_id, record)) = self.find_invocation(&callback.invocation_id)
                else {
                    self.begin_graph_fatal(
                        plugin_id(&callback.plugin_id)
                            .map(|id| (id, PluginGraphFenceCause::ChildFatal)),
                    );
                    return;
                };
                let Some(node) = self.nodes.get(&record.plugin_id) else {
                    self.begin_graph_fatal(None);
                    return;
                };
                if callback.callback_id != record.next_callback_id
                    || record.expected_callback.is_some()
                    || validate_capability_request_authority(
                        &node.load_frame,
                        &record.invoke_frame,
                        &frame,
                    )
                    .is_err()
                {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                }
                let Some(token) = pending_body else {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                };
                self.pending_body = Some(PendingBody {
                    frame: frame.clone(),
                    plugin_id: record.plugin_id.clone(),
                    invocation_id,
                });
                if self.authorize_body(token).is_err() {
                    self.begin_graph_fatal(None);
                }
                let _ = kind;
            }
            ChildFrame::Outcome { fence, kind, .. } => {
                let Some((invocation_id, record)) = self.find_invocation(&fence.invocation_id)
                else {
                    self.begin_graph_fatal(
                        plugin_id(&fence.plugin_id)
                            .map(|id| (id, PluginGraphFenceCause::ChildFatal)),
                    );
                    return;
                };
                if fence != &record.fence
                    || *kind != record.kind
                    || (!matches!(
                        record.phase,
                        InvocationPhase::Running | InvocationPhase::Cancelling
                    ) && !record.awaiting_child_terminal)
                {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                }
                let Some(token) = pending_body else {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                };
                self.pending_body = Some(PendingBody {
                    frame: frame.clone(),
                    plugin_id: record.plugin_id.clone(),
                    invocation_id,
                });
                if self.authorize_body(token).is_err() {
                    self.begin_graph_fatal(None);
                }
            }
            ChildFrame::Cancelled { fence } => {
                if pending_body.is_some() {
                    self.begin_graph_fatal(None);
                    return;
                }
                let Some((invocation_id, record)) = self.find_invocation(&fence.invocation_id)
                else {
                    self.begin_graph_fatal(
                        plugin_id(&fence.plugin_id)
                            .map(|id| (id, PluginGraphFenceCause::ChildFatal)),
                    );
                    return;
                };
                if fence != &record.fence || !record.awaiting_child_terminal {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                }
                self.handle_child_terminal(invocation_id);
            }
            ChildFrame::Failed { fence, code } => {
                if pending_body.is_some() {
                    self.begin_graph_fatal(None);
                    return;
                }
                let Some((invocation_id, record)) = self.find_invocation(&fence.invocation_id)
                else {
                    self.begin_graph_fatal(
                        plugin_id(&fence.plugin_id)
                            .map(|id| (id, PluginGraphFenceCause::ChildFatal)),
                    );
                    return;
                };
                if fence != &record.fence {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                }
                if record.awaiting_child_terminal {
                    self.handle_child_terminal(invocation_id);
                    return;
                }
                if !matches!(record.phase, InvocationPhase::Running) {
                    self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    )));
                    return;
                }
                match code {
                    HostFailureCode::GuestError => self.fail_plugin_invocation(
                        invocation_id,
                        InvocationFailure::GuestTrap,
                        PluginAttemptFailureCause::GuestTrap,
                    ),
                    HostFailureCode::Timeout => self.fail_plugin_invocation(
                        invocation_id,
                        InvocationFailure::Timeout,
                        PluginAttemptFailureCause::Timeout,
                    ),
                    HostFailureCode::ResourceLimit => self.fail_plugin_invocation(
                        invocation_id,
                        InvocationFailure::ResourceLimit,
                        PluginAttemptFailureCause::ResourceLimit,
                    ),
                    _ => self.begin_graph_fatal(Some((
                        record.plugin_id.clone(),
                        PluginGraphFenceCause::ChildFatal,
                    ))),
                }
            }
            ChildFrame::Unloaded { fence } => {
                self.begin_graph_fatal(
                    plugin_id(&fence.plugin_id).map(|id| (id, PluginGraphFenceCause::ChildFatal)),
                );
            }
            ChildFrame::Hello { .. }
            | ChildFrame::Loaded { .. }
            | ChildFrame::ShutdownComplete { .. } => self.begin_graph_fatal(None),
        }
    }

    fn authorize_body(
        &self,
        token: PendingPluginHostBodyToken,
    ) -> Result<(), PluginHostProcessError> {
        self.driver
            .as_ref()
            .ok_or(PluginHostProcessError::Closed)?
            .commands
            .authorize_body(
                token,
                Instant::now()
                    .checked_add(DRAIN_DEADLINE)
                    .unwrap_or_else(Instant::now),
            )
    }

    fn handle_body(&mut self, frame: ChildFrame, body: Vec<u8>) {
        let Some(pending) = self.pending_body.take() else {
            self.begin_graph_fatal(None);
            return;
        };
        if pending.frame != frame {
            self.begin_graph_fatal(Some((pending.plugin_id, PluginGraphFenceCause::ChildFatal)));
            return;
        }
        match frame.clone() {
            ChildFrame::CapabilityRequest { callback, kind, .. } => {
                let request = match decode_host_call_request(kind, &body) {
                    Ok(request) => request,
                    Err(_) => {
                        self.begin_graph_fatal(Some((
                            pending.plugin_id,
                            PluginGraphFenceCause::ChildFatal,
                        )));
                        return;
                    }
                };
                if self
                    .invocations
                    .get(&pending.invocation_id)
                    .is_some_and(|record| {
                        record.awaiting_child_terminal
                            || matches!(record.phase, InvocationPhase::Cancelling)
                    })
                {
                    self.send_immediate_callback_reply(
                        pending.invocation_id,
                        frame,
                        callback,
                        kind,
                        denied_host_reply(kind),
                    );
                } else if matches!(request, HostCallRequest::CallService(_)) {
                    self.handle_service_callback(pending.invocation_id, frame, callback, request);
                } else {
                    self.dispatch_callback(pending.invocation_id, frame, callback, kind, request);
                }
            }
            ChildFrame::Outcome { kind, .. } => {
                let outcome = match decode_invocation_outcome(kind, &body) {
                    Ok(outcome) => outcome,
                    Err(_) => {
                        self.begin_graph_fatal(Some((
                            pending.plugin_id,
                            PluginGraphFenceCause::ChildFatal,
                        )));
                        return;
                    }
                };
                self.handle_outcome(pending.invocation_id, outcome);
            }
            _ => {
                self.begin_graph_fatal(Some((pending.plugin_id, PluginGraphFenceCause::ChildFatal)))
            }
        }
    }

    fn dispatch_callback(
        &mut self,
        invocation_id: OperationId,
        original: ChildFrame,
        callback: CallbackFence,
        kind: HostCallKind,
        request: HostCallRequest,
    ) {
        let Some(record) = self.invocations.get_mut(&invocation_id) else {
            self.begin_graph_fatal(None);
            return;
        };
        if record.expected_callback.is_some() {
            let plugin_id = record.plugin_id.clone();
            self.begin_graph_fatal(Some((plugin_id, PluginGraphFenceCause::ChildFatal)));
            return;
        }
        let dispatcher = Arc::clone(&self.callback_dispatcher);
        let sender = self.internal_sender.clone();
        let callback_for_task = callback.clone();
        let task = self.background.spawn(async move {
            let result = dispatcher.dispatch(request).await;
            let _ = sender
                .send(InternalEvent::Callback {
                    invocation_id,
                    callback: callback_for_task,
                    kind,
                    result,
                })
                .await;
        });
        record.expected_callback = Some(ExpectedCallback {
            frame: original,
            callback,
            kind,
            task: Some(task),
        });
    }

    fn handle_service_callback(
        &mut self,
        parent_id: OperationId,
        original: ChildFrame,
        callback: CallbackFence,
        request: HostCallRequest,
    ) {
        let HostCallRequest::CallService(call) = request else {
            unreachable!("service request selected");
        };
        let Some(parent) = self.invocations.get(&parent_id) else {
            self.begin_graph_fatal(None);
            return;
        };
        let kind = HostCallKind::CallService;
        let denied =
            if !service_call_allowed(parent, &call.plugin_id, &call.service_id, &self.nodes) {
                Some(unavailable_service_reply())
            } else if parent.service_depth >= SERVICE_ANCESTRY_DEPTH_MAX {
                Some(denied_service_reply(
                    ErrorCode::InvalidInput,
                    "service ancestry is too deep",
                ))
            } else {
                None
            };
        if let Some(reply) = denied {
            self.send_immediate_callback_reply(parent_id, original, callback, kind, reply);
            return;
        }
        let Ok(target_id) = PluginId::parse(call.plugin_id.clone()) else {
            self.send_immediate_callback_reply(
                parent_id,
                original,
                callback,
                kind,
                unavailable_service_reply(),
            );
            return;
        };
        let Ok(entry) = PluginId::parse(call.service_id.clone()) else {
            self.send_immediate_callback_reply(
                parent_id,
                original,
                callback,
                kind,
                unavailable_service_reply(),
            );
            return;
        };
        let ancestry = parent.ancestry.clone();
        let depth = parent.service_depth + 1;
        let nested_parent = NestedParent {
            invocation_id: parent_id,
            callback: callback.clone(),
        };
        let started = self.start_nested_invocation(
            OperationId::new(),
            target_id,
            InvocationRequest::call_service(Some(entry.to_string()), call),
            ancestry,
            depth,
            nested_parent,
        );
        if started.is_err() {
            let reply = if started == Err(PluginRuntimeError::ServiceDepth) {
                denied_service_reply(ErrorCode::InvalidInput, "service ancestry is too deep")
            } else {
                unavailable_service_reply()
            };
            self.send_immediate_callback_reply(parent_id, original, callback, kind, reply);
            return;
        }
        if let Some(parent) = self.invocations.get_mut(&parent_id) {
            parent.expected_callback = Some(ExpectedCallback {
                frame: original,
                callback,
                kind,
                task: None,
            });
        }
    }

    fn check_invocation_admission(
        &self,
        plugin_id: &PluginId,
        resync: bool,
        ancestry: &[PluginId],
        service_depth: u8,
    ) -> Result<(), PluginRuntimeError> {
        if self.lifecycle != PluginRuntimeLifecycle::Running || self.drain.is_some() {
            return Err(PluginRuntimeError::Closed);
        }
        let node = self
            .nodes
            .get(plugin_id)
            .ok_or(PluginRuntimeError::NotAdmitting)?;
        let admits = if resync {
            node.plugin.desired_enabled && node.plugin.runtime_state == PluginRuntimeState::Starting
        } else {
            node.admitting
        };
        if !admits {
            return Err(PluginRuntimeError::NotAdmitting);
        }
        if service_depth > SERVICE_ANCESTRY_DEPTH_MAX {
            return Err(PluginRuntimeError::ServiceDepth);
        }
        if ancestry.last() == Some(plugin_id) {
            return Err(PluginRuntimeError::ReentrantService);
        }
        if ancestry.contains(plugin_id) {
            return Err(PluginRuntimeError::ServiceCycle);
        }
        let mut cancelled_only = self
            .cancelled_reservations
            .iter()
            .filter(|(operation_id, _)| !self.invocations.contains_key(operation_id))
            .map(|(_, reservation)| reservation);
        if self.invocations.len() + cancelled_only.clone().count() >= ACTIVE_INVOCATIONS_MAX {
            return Err(PluginRuntimeError::InvocationLimit);
        }
        if self
            .invocations
            .values()
            .any(|record| record.plugin_id == *plugin_id)
            || cancelled_only.any(|reservation| reservation.plugin_id == *plugin_id)
        {
            return Err(PluginRuntimeError::PluginBusy);
        }
        Ok(())
    }

    fn start_nested_invocation(
        &mut self,
        operation_id: OperationId,
        plugin_id: PluginId,
        request: InvocationRequest,
        mut ancestry: Vec<PluginId>,
        service_depth: u8,
        nested_parent: NestedParent,
    ) -> Result<(), PluginRuntimeError> {
        if self.invocations.contains_key(&operation_id)
            || self.cancelled_reservations.contains_key(&operation_id)
        {
            return Err(PluginRuntimeError::AuthorityRejected);
        }
        self.check_invocation_admission(&plugin_id, false, &ancestry, service_depth)
            .map_err(|error| match error {
                PluginRuntimeError::NotAdmitting => PluginRuntimeError::ServiceUnavailable,
                error => error,
            })?;
        let node = self
            .nodes
            .get(&plugin_id)
            .expect("nested admission checked the selected node");
        let session_id = self
            .host_session_id
            .clone()
            .ok_or(PluginRuntimeError::Dormant)?;
        let permission_hash = match &node.load_frame {
            ParentFrame::Load {
                permission_hash, ..
            } => permission_hash.clone(),
            _ => return Err(PluginRuntimeError::AuthorityRejected),
        };
        let fence = AuthorityFence {
            plugin_id: plugin_id.to_string(),
            package_generation: node.plugin.package_generation,
            activation_epoch: node.plugin.activation_epoch,
            host_session_id: session_id,
            invocation_id: operation_id.to_string(),
        };
        let (invoke_frame, body) = request
            .clone()
            .into_parent_message(fence.clone(), permission_hash)
            .map_err(|_| PluginRuntimeError::AuthorityRejected)?
            .into_parts();
        ancestry.push(plugin_id.clone());
        let record = InvocationRecord {
            operation_id,
            plugin_id,
            package_generation: fence.package_generation,
            activation_epoch: fence.activation_epoch,
            fence,
            kind: request.kind(),
            invoke_frame,
            body,
            phase: InvocationPhase::Running,
            ancestry,
            service_depth,
            next_callback_id: 1,
            expected_callback: None,
            deadline: None,
            awaiting_child_terminal: false,
            cancel_requested: Arc::new(AtomicBool::new(false)),
            terminal: None,
            nested_parent: Some(nested_parent),
            durable: false,
        };
        match self.invocations.entry(operation_id) {
            Entry::Vacant(entry) => {
                entry.insert(record);
            }
            Entry::Occupied(_) => return Err(PluginRuntimeError::AuthorityRejected),
        }
        self.send_invocation(operation_id);
        Ok(())
    }

    fn send_immediate_callback_reply(
        &mut self,
        parent_id: OperationId,
        frame: ChildFrame,
        callback: CallbackFence,
        kind: HostCallKind,
        reply: HostCallReply,
    ) {
        let Some(parent) = self.invocations.get_mut(&parent_id) else {
            return;
        };
        parent.expected_callback = Some(ExpectedCallback {
            frame,
            callback: callback.clone(),
            kind,
            task: None,
        });
        self.handle_callback_result(parent_id, callback, kind, Ok(reply));
    }

    fn handle_outcome(&mut self, invocation_id: OperationId, outcome: GuestInvocationOutcome) {
        let Some(record) = self.invocations.get(&invocation_id) else {
            self.begin_graph_fatal(None);
            return;
        };
        if record.awaiting_child_terminal {
            self.handle_child_terminal(invocation_id);
            return;
        }
        if record.nested_parent.is_some() {
            self.finish_nested(invocation_id, outcome);
            return;
        }
        let service = Arc::clone(&self.service);
        let sender = self.internal_sender.clone();
        let operation_id = record.operation_id;
        let plugin_id = record.plugin_id.clone();
        let generation = record.package_generation;
        let epoch = record.activation_epoch;
        let terminal = if outcome_has_deferred_effect(&outcome) {
            InvocationOutcome::Failed(InvocationFailure::AuthorityRejected)
        } else {
            InvocationOutcome::Completed(Box::new(outcome))
        };
        if let Some(record) = self.invocations.get_mut(&invocation_id) {
            record.deadline = None;
            record.phase = InvocationPhase::Completing(terminal);
        }
        self.background.spawn(async move {
            let result = service
                .complete_invocation(operation_id, plugin_id, generation, epoch, Timestamp::now())
                .await;
            let _ = sender
                .send(InternalEvent::Completion {
                    invocation_id,
                    result,
                })
                .await;
        });
    }

    fn handle_child_terminal(&mut self, invocation_id: OperationId) {
        let remove = self
            .invocations
            .get_mut(&invocation_id)
            .is_some_and(|record| {
                record.awaiting_child_terminal = false;
                record.deadline = None;
                matches!(record.phase, InvocationPhase::Cancelling)
            });
        if remove {
            self.invocations.remove(&invocation_id);
        }
    }

    fn finish_nested(&mut self, invocation_id: OperationId, outcome: GuestInvocationOutcome) {
        let Some(mut nested) = self.invocations.remove(&invocation_id) else {
            return;
        };
        let Some(parent) = nested.nested_parent.take() else {
            return;
        };
        let reply = match outcome {
            GuestInvocationOutcome::CallService(WitResult::Ok(data)) => {
                HostCallReply::CallService(WitResult::Ok(data))
            }
            GuestInvocationOutcome::CallService(WitResult::Err(error)) => {
                HostCallReply::CallService(WitResult::Err(plugin_error_to_host(error)))
            }
            _ => unavailable_service_reply(),
        };
        self.handle_callback_result(
            parent.invocation_id,
            parent.callback,
            HostCallKind::CallService,
            Ok(reply),
        );
    }

    fn timeout_plugin_invocation(&mut self, invocation_id: OperationId) {
        let Some(record) = self.invocations.get_mut(&invocation_id) else {
            return;
        };
        if !matches!(record.phase, InvocationPhase::Running) {
            return;
        }
        if let Some(expected) = record.expected_callback.as_mut()
            && let Some(task) = expected.task.take()
        {
            task.abort();
        }
        let cancel = ParentMessage::new(
            ParentFrame::Cancel {
                fence: record.fence.clone(),
            },
            Vec::new(),
        );
        let sent = self
            .driver
            .as_ref()
            .ok_or(PluginHostProcessError::Closed)
            .and_then(|driver| {
                driver.commands.send(
                    cancel,
                    Instant::now()
                        .checked_add(DRAIN_DEADLINE)
                        .unwrap_or_else(Instant::now),
                )
            });
        if sent.is_err() {
            self.begin_graph_fatal(None);
            return;
        }
        record.awaiting_child_terminal = true;
        record.deadline = Some(tokio::time::Instant::now() + DRAIN_DEADLINE);
        self.fail_plugin_invocation(
            invocation_id,
            InvocationFailure::Timeout,
            PluginAttemptFailureCause::Timeout,
        );
    }

    fn fail_plugin_invocation(
        &mut self,
        invocation_id: OperationId,
        failure: InvocationFailure,
        cause: PluginAttemptFailureCause,
    ) {
        let Some(mut record) = self.invocations.remove(&invocation_id) else {
            return;
        };
        if !matches!(record.phase, InvocationPhase::Running) {
            self.invocations.insert(invocation_id, record);
            return;
        }
        if let Some(expected) = record.expected_callback.as_mut()
            && let Some(task) = expected.task.take()
        {
            task.abort();
        }
        if let Some(node) = self.nodes.get_mut(&record.plugin_id) {
            node.admitting = false;
        }
        let plugin_id = record.plugin_id.clone();
        let package_generation = record.package_generation;
        let activation_epoch = record.activation_epoch;
        let outcome = InvocationOutcome::Failed(failure);
        if record.durable {
            record.phase = InvocationPhase::CompletingFailure { outcome, cause };
            let service = Arc::clone(&self.service);
            let sender = self.internal_sender.clone();
            let operation_id = record.operation_id;
            self.invocations.insert(invocation_id, record);
            self.background.spawn(async move {
                let result = service
                    .complete_invocation(
                        operation_id,
                        plugin_id,
                        package_generation,
                        activation_epoch,
                        Timestamp::now(),
                    )
                    .await;
                let _ = sender
                    .send(InternalEvent::Completion {
                        invocation_id,
                        result,
                    })
                    .await;
            });
        } else {
            record.phase = InvocationPhase::RecordingFailure(Some(outcome));
            self.invocations.insert(invocation_id, record);
            self.spawn_failure_record(
                invocation_id,
                plugin_id,
                package_generation,
                activation_epoch,
                cause,
            );
        }
    }

    fn spawn_failure_record(
        &mut self,
        invocation_id: OperationId,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        cause: PluginAttemptFailureCause,
    ) {
        let service = Arc::clone(&self.service);
        let sender = self.internal_sender.clone();
        let request = RecordPluginAttemptFailureRequest {
            plugin_id,
            package_generation,
            activation_epoch,
            cause,
        };
        self.background.spawn(async move {
            let result = service
                .record_failure(OperationId::new(), request, Timestamp::now())
                .await;
            let _ = sender
                .send(InternalEvent::FailureRecorded {
                    invocation_id,
                    result,
                })
                .await;
        });
    }

    fn finish_with_failure(&mut self, invocation_id: OperationId, failure: InvocationFailure) {
        if let Some(mut record) = self.invocations.remove(&invocation_id) {
            self.publish_terminal(&mut record, InvocationOutcome::Failed(failure));
        }
    }

    fn publish_terminal(&mut self, record: &mut InvocationRecord, outcome: InvocationOutcome) {
        if let Some(parent) = record.nested_parent.take() {
            let reply = match outcome {
                InvocationOutcome::Cancelled => {
                    denied_service_reply(ErrorCode::Cancelled, "service call cancelled")
                }
                _ => unavailable_service_reply(),
            };
            self.handle_callback_result(
                parent.invocation_id,
                parent.callback,
                HostCallKind::CallService,
                Ok(reply),
            );
        } else if let Some(terminal) = record.terminal.take() {
            let _ = terminal.send(outcome);
        }
    }

    fn find_invocation(&self, raw: &str) -> Option<(OperationId, &InvocationRecord)> {
        let id = OperationId::parse(raw).ok()?;
        self.invocations.get(&id).map(|record| (id, record))
    }

    fn begin_graph_fatal(&mut self, trigger: Option<(PluginId, PluginGraphFenceCause)>) {
        self.prepare_graph_fence(trigger);
        if let Some(driver) = self.driver.as_ref() {
            let _ = driver.commands.fatal_close();
        }
    }

    fn prepare_graph_fence(&mut self, trigger: Option<(PluginId, PluginGraphFenceCause)>) {
        let graph: Vec<_> = self
            .activation_order
            .iter()
            .filter_map(|id| self.nodes.get(id).map(|node| node.plugin.clone()))
            .collect();
        let host_session_id = self.host_session_id.clone().unwrap_or_default();
        let completion = if let Some(drain) = self.drain.as_mut() {
            let previous = std::mem::replace(&mut drain.purpose, DrainPurpose::Fenced);
            match previous {
                DrainPurpose::Reconfigure(pending) => FenceCompletion::Reconfigure(pending.reply),
                DrainPurpose::Stop(pending) => FenceCompletion::Stop(pending.reply),
                DrainPurpose::DetachedStop => FenceCompletion::None,
                previous @ DrainPurpose::Fence { .. } | previous @ DrainPurpose::Fenced => {
                    drain.purpose = previous;
                    return;
                }
            }
        } else {
            FenceCompletion::None
        };
        self.terminalize_invocations(InvocationOutcome::Failed(InvocationFailure::SessionLost));
        for node in self.nodes.values_mut() {
            node.admitting = false;
        }
        self.lifecycle = PluginRuntimeLifecycle::Draining;
        self.drain = Some(DrainState {
            purpose: DrainPurpose::Fence {
                trigger,
                graph,
                host_session_id,
                completion,
            },
            deadline: tokio::time::Instant::now() + DRAIN_DEADLINE,
        });
    }

    fn terminalize_invocations(&mut self, outcome: InvocationOutcome) {
        let ids: Vec<_> = self.invocations.keys().copied().collect();
        let mut outcome = Some(outcome);
        for id in ids {
            if let Some(mut record) = self.invocations.remove(&id) {
                if let Some(expected) = record.expected_callback.as_mut()
                    && let Some(task) = expected.task.take()
                {
                    task.abort();
                }
                if record.terminal.is_some() || record.nested_parent.is_some() {
                    let terminal = outcome
                        .take()
                        .unwrap_or(InvocationOutcome::Failed(InvocationFailure::SessionLost));
                    self.publish_terminal(&mut record, terminal);
                }
            }
        }
    }

    async fn begin_drain(&mut self, purpose: DrainPurpose) {
        if self.drain.is_some() {
            return;
        }
        for node in self.nodes.values_mut() {
            node.admitting = false;
        }
        self.lifecycle = PluginRuntimeLifecycle::Draining;
        self.drain = Some(DrainState {
            purpose,
            deadline: tokio::time::Instant::now() + DRAIN_DEADLINE,
        });
        let ids: Vec<_> = self.invocations.keys().copied().collect();
        for id in ids {
            self.cancel_invocation(id);
        }
        if matches!(
            self.drain.as_ref().map(|drain| &drain.purpose),
            Some(DrainPurpose::Fence { .. })
        ) {
            return;
        }
        if let Some(driver) = self.driver.as_ref() {
            if driver.commands.shutdown().is_err() {
                self.begin_graph_fatal(None);
            }
        } else {
            self.finish_drain(Ok(())).await;
        }
    }

    async fn handle_driver_closed(&mut self, result: Result<(), PluginHostProcessError>) {
        let pending_trigger = self
            .pending_body
            .take()
            .map(|pending| (pending.plugin_id, PluginGraphFenceCause::ChildFatal));
        let ordinary_drain = matches!(
            self.drain.as_ref().map(|drain| &drain.purpose),
            Some(DrainPurpose::Reconfigure(_) | DrainPurpose::Stop(_) | DrainPurpose::DetachedStop)
        );
        if self.drain.is_none() || (result.is_err() && ordinary_drain) {
            self.prepare_graph_fence(pending_trigger);
        }
        self.terminalize_invocations(InvocationOutcome::Failed(InvocationFailure::SessionLost));
        if let Some(driver) = self.driver.take() {
            let _ = driver.pump.await;
            drop(driver.commands);
        }
        self.finish_drain(result).await;
    }

    async fn finish_drain(&mut self, result: Result<(), PluginHostProcessError>) {
        let Some(drain) = self.drain.take() else {
            return;
        };
        self.nodes.clear();
        self.activation_order.clear();
        self.host_session_id = None;
        self.pending_body = None;
        match drain.purpose {
            DrainPurpose::Reconfigure(pending) => {
                if result.is_ok() {
                    self.lifecycle = PluginRuntimeLifecycle::Dormant;
                    Box::pin(self.launch(pending.plan, pending.reply)).await;
                } else {
                    self.enter_fenced();
                    let _ = pending.reply.send(Err(PluginRuntimeError::Fenced));
                    self.exit_when_idle = true;
                }
            }
            DrainPurpose::Stop(pending) => {
                self.lifecycle = match pending.reason {
                    StopReason::Restore => PluginRuntimeLifecycle::Dormant,
                    StopReason::Shutdown => PluginRuntimeLifecycle::Shutdown,
                };
                let response = if result.is_ok() {
                    Ok(())
                } else {
                    Err(PluginRuntimeError::Closed)
                };
                let _ = pending.reply.send(response);
                self.exit_when_idle = true;
            }
            DrainPurpose::DetachedStop => {
                self.lifecycle = PluginRuntimeLifecycle::Shutdown;
                self.exit_when_idle = true;
            }
            DrainPurpose::Fence {
                trigger,
                graph,
                host_session_id,
                completion,
            } => {
                let fenced = self
                    .fence_current_graph(&graph, trigger, host_session_id)
                    .await;
                if !fenced {
                    self.enter_fenced();
                } else {
                    self.lifecycle = PluginRuntimeLifecycle::Dormant;
                }
                match completion {
                    FenceCompletion::None => {}
                    FenceCompletion::Reconfigure(reply) => {
                        let _ = reply.send(Err(if fenced {
                            PluginRuntimeError::SessionLost
                        } else {
                            PluginRuntimeError::Fenced
                        }));
                    }
                    FenceCompletion::Stop(reply) => {
                        let _ = reply.send(Err(if fenced {
                            PluginRuntimeError::Closed
                        } else {
                            PluginRuntimeError::Fenced
                        }));
                    }
                }
                self.exit_when_idle = true;
            }
            DrainPurpose::Fenced => {
                self.enter_fenced();
                self.exit_when_idle = true;
            }
        }
    }

    async fn fence_current_graph(
        &self,
        loaded_graph: &[InstalledPlugin],
        trigger: Option<(PluginId, PluginGraphFenceCause)>,
        host_session_id: String,
    ) -> bool {
        let Ok(graph) = self.current_fence_graph(loaded_graph).await else {
            return false;
        };
        if graph.is_empty() {
            return true;
        }
        let trigger = trigger
            .filter(|(plugin_id, _)| graph.iter().any(|plugin| plugin.plugin_id == *plugin_id));
        self.service
            .fence_graph(
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id,
                    entries: graph_fence_entries(&graph, trigger),
                },
                Timestamp::now(),
            )
            .await
            .is_ok()
    }

    async fn current_fence_graph(
        &self,
        loaded_graph: &[InstalledPlugin],
    ) -> Result<Vec<InstalledPlugin>, PluginRuntimeError> {
        let profile = self
            .service
            .profile()
            .await
            .map_err(|_| PluginRuntimeError::AuthorityRejected)?;
        let plan = RuntimePlan::from_profile(profile)?;
        let loaded: BTreeMap<_, _> = loaded_graph
            .iter()
            .map(|plugin| (plugin.plugin_id.clone(), plugin))
            .collect();
        if plan.selected.iter().any(|plugin| {
            loaded.get(&plugin.plugin_id).is_none_or(|selected| {
                selected.package_generation != plugin.package_generation
                    || selected.activation_epoch != plugin.activation_epoch
            })
        }) {
            return Err(PluginRuntimeError::AuthorityRejected);
        }
        Ok(plan.selected)
    }

    async fn handle_stop(
        &mut self,
        reason: StopReason,
        reply: oneshot::Sender<Result<(), PluginRuntimeError>>,
    ) {
        if self.driver.is_some() {
            self.begin_drain(DrainPurpose::Stop(PendingStop { reason, reply }))
                .await;
        } else {
            self.lifecycle = match reason {
                StopReason::Restore => PluginRuntimeLifecycle::Dormant,
                StopReason::Shutdown => PluginRuntimeLifecycle::Shutdown,
            };
            let _ = reply.send(Ok(()));
            self.exit_when_idle = true;
        }
    }

    async fn begin_stop_without_reply(&mut self) {
        if self.driver.is_some() {
            for node in self.nodes.values_mut() {
                node.admitting = false;
            }
            let ids: Vec<_> = self.invocations.keys().copied().collect();
            for id in ids {
                self.cancel_invocation(id);
            }
            self.lifecycle = PluginRuntimeLifecycle::Draining;
            self.drain = Some(DrainState {
                purpose: DrainPurpose::DetachedStop,
                deadline: tokio::time::Instant::now() + DRAIN_DEADLINE,
            });
            if let Some(driver) = self.driver.as_ref()
                && driver.commands.shutdown().is_err()
            {
                let _ = driver.commands.fatal_close();
            }
        }
    }

    fn snapshot(&self) -> PluginRuntimeSnapshot {
        PluginRuntimeSnapshot {
            lifecycle: self.lifecycle,
            graph_size: self.nodes.len(),
            active_invocations: self.invocations.len()
                + self
                    .cancelled_reservations
                    .keys()
                    .filter(|operation_id| !self.invocations.contains_key(operation_id))
                    .count(),
            admitting_plugins: self
                .nodes
                .iter()
                .filter(|(_, node)| node.admitting)
                .map(|(plugin_id, _)| plugin_id.clone())
                .collect(),
        }
    }

    fn enter_fenced(&mut self) {
        self.fenced.store(true, Ordering::Release);
        self.lifecycle = PluginRuntimeLifecycle::Fenced;
        for node in self.nodes.values_mut() {
            node.admitting = false;
        }
    }
}

struct LaunchedProcess {
    host_session_id: String,
    nodes: Vec<LoadedNode>,
    commands: PluginHostRuntimeDriverHandle,
    events: PluginHostRuntimeEvents,
}

struct LaunchFailure {
    host_session_id: Option<String>,
    failing_plugin: Option<PluginId>,
    cause: PluginGraphFenceCause,
    package_fault: bool,
}

impl LaunchFailure {
    fn worker() -> Self {
        Self {
            host_session_id: None,
            failing_plugin: None,
            cause: PluginGraphFenceCause::SessionLost,
            package_fault: false,
        }
    }
}

fn launch_process(
    policy: PluginHostLaunchPolicy,
    plugins: Vec<InstalledPlugin>,
    sources: Vec<OpenedPluginComponentSource>,
) -> Result<LaunchedProcess, LaunchFailure> {
    let mut sources_by_id = BTreeMap::new();
    for source in sources {
        let source_id = source.plugin_id().clone();
        if sources_by_id.insert(source_id.clone(), source).is_some() {
            return Err(LaunchFailure {
                host_session_id: None,
                failing_plugin: Some(source_id),
                cause: PluginGraphFenceCause::CompileLoad,
                package_fault: true,
            });
        }
    }
    if plugins.len() != sources_by_id.len()
        || plugins
            .iter()
            .any(|plugin| !sources_by_id.contains_key(&plugin.plugin_id))
    {
        return Err(LaunchFailure {
            host_session_id: None,
            failing_plugin: None,
            cause: PluginGraphFenceCause::CompileLoad,
            package_fault: true,
        });
    }
    // Session generation is intentionally adjacent to connect, after the
    // complete source authority has been opened and before any child exists.
    let session = policy
        .next_session_id()
        .map_err(|_| LaunchFailure::worker())?;
    let session_string = session.hyphenated().to_string();
    let mut process = policy.connect(session).map_err(|_| LaunchFailure {
        host_session_id: Some(session_string.clone()),
        failing_plugin: None,
        cause: PluginGraphFenceCause::SessionLost,
        package_fault: false,
    })?;
    let mut nodes = Vec::with_capacity(plugins.len());
    for plugin in &plugins {
        let mut source = sources_by_id
            .remove(&plugin.plugin_id)
            .expect("source graph exact-matched before connect");
        if source.package_generation() != plugin.package_generation
            || source.activation_epoch() != plugin.activation_epoch
        {
            let _ = process.fatal_close();
            return Err(LaunchFailure {
                host_session_id: Some(session_string),
                failing_plugin: Some(plugin.plugin_id.clone()),
                cause: PluginGraphFenceCause::CompileLoad,
                package_fault: true,
            });
        }
        let length = usize::try_from(source.component_length()).map_err(|_| LaunchFailure {
            host_session_id: Some(session_string.clone()),
            failing_plugin: Some(plugin.plugin_id.clone()),
            cause: PluginGraphFenceCause::CompileLoad,
            package_fault: true,
        })?;
        let mut component = vec![0_u8; length];
        if source.read_exact(&mut component).is_err()
            || Sha256Digest::of(&component) != *source.component_sha256()
        {
            let _ = process.fatal_close();
            return Err(LaunchFailure {
                host_session_id: Some(session_string),
                failing_plugin: Some(plugin.plugin_id.clone()),
                cause: PluginGraphFenceCause::CompileLoad,
                package_fault: true,
            });
        }
        let load_invocation = OperationId::new();
        let fence = AuthorityFence {
            plugin_id: plugin.plugin_id.to_string(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            host_session_id: session_string.clone(),
            invocation_id: load_invocation.to_string(),
        };
        let permission_hash =
            canonical_permission_hash(source.grants()).ok_or_else(|| LaunchFailure {
                host_session_id: Some(session_string.clone()),
                failing_plugin: Some(plugin.plugin_id.clone()),
                cause: PluginGraphFenceCause::CompileLoad,
                package_fault: false,
            })?;
        let load_frame = ParentFrame::Load {
            fence: fence.clone(),
            package_sha256: plugin.package_sha256.to_string(),
            component_sha256: source.component_sha256().to_string(),
            import_export_fingerprint: source.import_export_fingerprint().to_string(),
            runtime_profile: source.runtime_profile(),
            component_size: source.component_length(),
            grants: source.grants().to_vec(),
            permission_hash,
            limits: RuntimeLimits::for_profile(source.runtime_profile()),
        };
        let load = PluginHostLoad {
            fence,
            package_sha256: plugin.package_sha256.clone(),
            import_export_fingerprint: source.import_export_fingerprint().clone(),
            runtime_profile: source.runtime_profile(),
            grants: source.grants().to_vec(),
            component,
        };
        if let Err(error) = process.load(load) {
            let correlated = matches!(
                error,
                PluginHostProcessError::CompileLoadTimeout
                    | PluginHostProcessError::LoadFailed(_)
                    | PluginHostProcessError::ProtocolRejected
            );
            return Err(LaunchFailure {
                host_session_id: Some(session_string),
                failing_plugin: correlated.then(|| plugin.plugin_id.clone()),
                cause: if correlated {
                    PluginGraphFenceCause::CompileLoad
                } else {
                    PluginGraphFenceCause::SessionLost
                },
                package_fault: matches!(
                    error,
                    PluginHostProcessError::LoadFailed(HostFailureCode::InvalidPackage)
                        | PluginHostProcessError::LoadFailed(HostFailureCode::InvalidComponent)
                ),
            });
        }
        nodes.push(LoadedNode {
            plugin: plugin.clone(),
            load_frame,
            admitting: false,
        });
    }
    process.finish_loading().map_err(|_| LaunchFailure {
        host_session_id: Some(session_string.clone()),
        failing_plugin: None,
        cause: PluginGraphFenceCause::SessionLost,
        package_fault: false,
    })?;
    let (commands, events) = process.into_runtime_driver().map_err(|_| LaunchFailure {
        host_session_id: Some(session_string.clone()),
        failing_plugin: None,
        cause: PluginGraphFenceCause::SessionLost,
        package_fault: false,
    })?;
    Ok(LaunchedProcess {
        host_session_id: session_string,
        nodes,
        commands,
        events,
    })
}

fn graph_fence_entries(
    graph: &[InstalledPlugin],
    trigger: Option<(PluginId, PluginGraphFenceCause)>,
) -> Vec<PluginGraphFenceEntry> {
    let triggered = trigger.as_ref().map(|(id, _)| id);
    let dependents: BTreeSet<_> = triggered
        .map(|triggered| {
            graph
                .iter()
                .filter(|plugin| plugin_depends_on(graph, plugin, triggered))
                .map(|plugin| plugin.plugin_id.clone())
                .collect()
        })
        .unwrap_or_default();
    let mut entries: Vec<_> = graph
        .iter()
        .map(|plugin| {
            let (cause, disposition) = if triggered == Some(&plugin.plugin_id) {
                (
                    trigger
                        .as_ref()
                        .map_or(PluginGraphFenceCause::ChildFatal, |(_, cause)| *cause),
                    PluginGraphFenceDisposition::Failing,
                )
            } else if dependents.contains(&plugin.plugin_id) {
                (
                    PluginGraphFenceCause::DependencyFailed,
                    PluginGraphFenceDisposition::SkippedDependent,
                )
            } else {
                (
                    PluginGraphFenceCause::SessionLost,
                    PluginGraphFenceDisposition::LoadedSibling,
                )
            };
            PluginGraphFenceEntry {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                cause,
                disposition,
            }
        })
        .collect();
    entries.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
    entries
}

fn plugin_depends_on(
    graph: &[InstalledPlugin],
    plugin: &InstalledPlugin,
    target: &PluginId,
) -> bool {
    let by_id: BTreeMap<_, _> = graph
        .iter()
        .map(|candidate| (candidate.plugin_id.as_str(), candidate))
        .collect();
    let mut pending: Vec<_> = plugin
        .manifest
        .dependencies
        .iter()
        .map(|dependency| dependency.id.as_str())
        .collect();
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if !visited.insert(id) {
            continue;
        }
        if id == target.as_str() {
            return true;
        }
        if let Some(dependency) = by_id.get(id) {
            pending.extend(
                dependency
                    .manifest
                    .dependencies
                    .iter()
                    .map(|nested| nested.id.as_str()),
            );
        }
    }
    false
}

fn dispatch_matches_hook(dispatch: &PluginInvocationDispatch) -> bool {
    matches!(
        (dispatch.reservation.hook_kind, dispatch.request.kind()),
        (PluginHookKind::InvokeCommand, InvocationKind::InvokeCommand)
            | (PluginHookKind::HandleEvent, InvocationKind::HandleEvent)
            | (
                PluginHookKind::HandleSurfaceAction,
                InvocationKind::HandleSurfaceAction
            )
            | (PluginHookKind::Resync, InvocationKind::Resync)
    )
}

fn outcome_has_deferred_effect(outcome: &GuestInvocationOutcome) -> bool {
    use junban_plugin_sdk::private_body_types::WitResult;
    match outcome {
        GuestInvocationOutcome::InvokeCommand(WitResult::Ok(outcome))
        | GuestInvocationOutcome::HandleEvent(WitResult::Ok(outcome))
        | GuestInvocationOutcome::HandleSurfaceAction(WitResult::Ok(outcome)) => {
            outcome.effect.is_some()
        }
        _ => false,
    }
}

fn service_call_allowed(
    parent: &InvocationRecord,
    target_id: &str,
    service_id: &str,
    nodes: &BTreeMap<PluginId, LoadedNode>,
) -> bool {
    if parent.plugin_id.as_str() == target_id
        || parent.ancestry.iter().any(|id| id.as_str() == target_id)
    {
        return false;
    }
    let Some(parent_node) = nodes.get(&parent.plugin_id) else {
        return false;
    };
    let Some(dependency) = parent_node
        .plugin
        .manifest
        .dependencies
        .iter()
        .find(|dependency| {
            dependency.id == target_id && dependency.services.iter().any(|id| id == service_id)
        })
    else {
        return false;
    };
    let _ = dependency;
    let Ok(target_id) = PluginId::parse(target_id.to_owned()) else {
        return false;
    };
    let Some(target) = nodes.get(&target_id) else {
        return false;
    };
    target.admitting
        && target
            .plugin
            .manifest
            .services
            .iter()
            .any(|service| service.id == service_id)
        && parent_node.plugin.granted_capabilities.contains(&junban_plugin_sdk::Capability::ServicesConsume)
        && parent_node.plugin.manifest.permissions.iter().any(|permission| {
            matches!(&permission.scope, PermissionScope::Services(scope)
                if scope.services.iter().any(|reference|
                    reference.plugin_id == target_id.as_str() && reference.service_id == service_id))
        })
}

fn denied_host_reply(kind: HostCallKind) -> HostCallReply {
    let error = HostError {
        code: ErrorCode::PermissionDenied,
        field: None,
        message: "host capability is not available in this runtime slice".to_owned(),
    };
    match kind {
        HostCallKind::QueryTasks => HostCallReply::QueryTasks(WitResult::Err(error)),
        HostCallKind::QueryProjects => HostCallReply::QueryProjects(WitResult::Err(error)),
        HostCallKind::QueryTags => HostCallReply::QueryTags(WitResult::Err(error)),
        HostCallKind::GetSettings => HostCallReply::GetSettings(WitResult::Err(error)),
        HostCallKind::GetKv => HostCallReply::GetKv(WitResult::Err(error)),
        HostCallKind::ListKv => HostCallReply::ListKv(WitResult::Err(error)),
        HostCallKind::HttpRequest => HostCallReply::HttpRequest(WitResult::Err(HttpError {
            code: HttpErrorCode::PermissionDenied,
            delivery: DeliveryState::NotSent,
            retryable: false,
            message: "host capability is not available in this runtime slice".to_owned(),
        })),
        HostCallKind::CallService => HostCallReply::CallService(WitResult::Err(error)),
        HostCallKind::WallNow | HostCallKind::MonotonicMs | HostCallKind::Log => {
            HostCallReply::Cancelled(kind)
        }
    }
}

fn denied_service_reply(code: ErrorCode, message: &str) -> HostCallReply {
    HostCallReply::CallService(WitResult::Err(HostError {
        code,
        field: None,
        message: message.to_owned(),
    }))
}

fn unavailable_service_reply() -> HostCallReply {
    denied_service_reply(ErrorCode::Unavailable, "dependency service is unavailable")
}

fn plugin_error_to_host(error: PluginError) -> HostError {
    HostError {
        code: error.code,
        field: error.field,
        message: error.message,
    }
}

fn plugin_id(raw: &str) -> Option<PluginId> {
    PluginId::parse(raw.to_owned()).ok()
}

fn frame_plugin_id(frame: &ChildFrame) -> Option<PluginId> {
    match frame {
        ChildFrame::CapabilityRequest { callback, .. } => plugin_id(&callback.plugin_id),
        ChildFrame::Loaded { fence, .. }
        | ChildFrame::Outcome { fence, .. }
        | ChildFrame::Cancelled { fence }
        | ChildFrame::Failed { fence, .. }
        | ChildFrame::Unloaded { fence } => plugin_id(&fence.plugin_id),
        ChildFrame::Hello { .. } | ChildFrame::ShutdownComplete { .. } => None,
    }
}

#[cfg(test)]
mod tests;
