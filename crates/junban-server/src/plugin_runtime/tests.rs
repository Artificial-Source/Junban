//! Deterministic, local-only supervisor fixtures and lifecycle regressions.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64},
    },
    time::Duration,
};

use junban_app::{
    CommunityPluginPolicy, PluginEventCursor, PluginInvocation, PluginInvocationState,
    PluginInvocationTerminalKind, PluginManifestEntry,
};
use junban_plugin_sdk::{
    Capability, CommandDeclaration, Dependency, Permission, PermissionScope, Publisher,
    RuntimeManifest, RuntimeProfile, ServiceConsumeScope, ServiceDeclaration, ServiceReference,
    UnscopedPermission, WitAuthority, canonical_permission_hash, permission_set_hash,
    private_body_types::{CommandCall, PluginOutcome, WitResult},
    scope_hash,
};
use junban_storage::ProfileOwner;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::{BroadcastEventSink, reminder_wake::ReminderWakeHub};

use super::*;
use crate::plugin_host_process::ProcessDeadlines;

fn timestamp(raw: &str) -> Timestamp {
    raw.parse().expect("test timestamp")
}

fn operation(index: u64) -> OperationId {
    OperationId::parse(&format!("00000000-0000-4000-8000-{index:012}")).expect("test operation")
}

fn session(index: u64) -> Uuid {
    Uuid::parse_str(&format!("00000000-0000-4000-9000-{index:012}")).expect("test session")
}

fn manifest(id: &str, dependencies: Vec<Dependency>) -> RuntimeManifest {
    RuntimeManifest {
        schema_version: junban_plugin_sdk::MANIFEST_SCHEMA_VERSION,
        id: id.to_owned(),
        name: id.to_owned(),
        description: "fixture".to_owned(),
        version: "1.0.0".to_owned(),
        publisher: Publisher {
            id: "fixture-publisher".to_owned(),
            name: "Fixture Publisher".to_owned(),
            key_id: "1".repeat(64),
        },
        license: "MIT".to_owned(),
        junban_compatibility: "^0.1.0".to_owned(),
        wit: WitAuthority {
            package: "junban:plugin".to_owned(),
            world: "plugin".to_owned(),
            version: "0.1.0".to_owned(),
        },
        runtime_profile: RuntimeProfile::Typescript,
        component_sha256: String::new(),
        permissions: Vec::new(),
        dependencies,
        commands: vec![CommandDeclaration {
            id: "command".to_owned(),
            title: "Command".to_owned(),
            description: "fixture command".to_owned(),
            icon: None,
            inputs: Vec::new(),
        }],
        subscriptions: Vec::new(),
        surfaces: Vec::new(),
        settings: Vec::new(),
        services: Vec::new(),
    }
}

fn installed_plugin(
    id: &str,
    generation: u64,
    epoch: u64,
    state: PluginRuntimeState,
    dependencies: Vec<Dependency>,
) -> InstalledPlugin {
    let component = [u8::try_from(generation).unwrap_or(1)];
    let mut manifest = manifest(id, dependencies);
    manifest.component_sha256 = Sha256Digest::of(&component).to_string();
    InstalledPlugin {
        plugin_id: PluginId::parse(id.to_owned()).expect("test plugin id"),
        manifest,
        version: "1.0.0".to_owned(),
        package_sha256: Sha256Digest::of(format!("package-{id}").as_bytes()),
        component_sha256: Sha256Digest::of(&component),
        publisher_key_id: Sha256Digest::parse("1".repeat(64)).expect("publisher digest"),
        package_generation: generation,
        activation_epoch: epoch,
        desired_enabled: true,
        runtime_state: state,
        granted_capabilities: vec![Capability::Commands],
        dependencies_satisfied: true,
        failure_count: 0,
        last_error_code: None,
        next_retry_at: None,
        installed_at: timestamp("2026-01-01T00:00:00Z"),
        updated_at: timestamp("2026-01-01T00:00:00Z"),
    }
}

fn profile(plugins: Vec<InstalledPlugin>, activation_order: Vec<&str>) -> InstalledPluginProfile {
    InstalledPluginProfile {
        plugins,
        activation_order: activation_order
            .into_iter()
            .map(|id| PluginId::parse(id.to_owned()).expect("activation id"))
            .collect(),
        community_policy: CommunityPluginPolicy {
            community_registry_enabled: false,
            updated_at: timestamp("2026-01-01T00:00:00Z"),
        },
    }
}

fn chain_profile(count: usize, state: PluginRuntimeState) -> InstalledPluginProfile {
    let mut plugins = Vec::new();
    let mut order = Vec::new();
    for index in 0..count {
        let id = format!("plugin-{index:02}");
        let dependencies = (index > 0)
            .then(|| Dependency {
                id: format!("plugin-{:02}", index - 1),
                requirement: "^1.0.0".to_owned(),
                services: Vec::new(),
            })
            .into_iter()
            .collect();
        plugins.push(installed_plugin(
            &id,
            u64::try_from(index + 1).expect("generation"),
            10,
            state,
            dependencies,
        ));
        order.push(id);
    }
    InstalledPluginProfile {
        plugins,
        activation_order: order
            .into_iter()
            .map(|id| PluginId::parse(id).expect("activation id"))
            .collect(),
        community_policy: CommunityPluginPolicy {
            community_registry_enabled: false,
            updated_at: timestamp("2026-01-01T00:00:00Z"),
        },
    }
}

#[derive(Default)]
struct ServiceCounts {
    profile: usize,
    open_sources: usize,
    reconcile_packages: usize,
    due_retries: usize,
    activations: usize,
    reservations: usize,
    completions: usize,
    failures: usize,
}

struct MockState {
    profile: InstalledPluginProfile,
    counts: ServiceCounts,
    opened_selections: Vec<Vec<PluginComponentSelection>>,
    activation_order: Vec<PluginId>,
    due_requests: Vec<DuePluginRetryRequest>,
    failure_requests: Vec<RecordPluginAttemptFailureRequest>,
    fence_requests: Vec<PluginGraphFenceRequest>,
    resync_required: BTreeSet<PluginId>,
    fail_activation: bool,
    fail_completion: bool,
    fail_fence: bool,
    source_counter: u64,
    reserve_gate: Option<Arc<Semaphore>>,
    reap_pid_file: Option<PathBuf>,
    fence_saw_reaped: Vec<bool>,
}

struct MockService {
    root: PathBuf,
    state: Arc<Mutex<MockState>>,
    fence_events: Arc<Semaphore>,
    reservation_events: Arc<Semaphore>,
    completion_events: Arc<Semaphore>,
    failure_events: Arc<Semaphore>,
}

impl MockService {
    fn new(label: &str, profile: InstalledPluginProfile) -> Arc<Self> {
        let root = unique_root(&format!("service-{label}"));
        fs::create_dir_all(&root).expect("service root");
        Arc::new(Self {
            root,
            state: Arc::new(Mutex::new(MockState {
                profile,
                counts: ServiceCounts::default(),
                opened_selections: Vec::new(),
                activation_order: Vec::new(),
                due_requests: Vec::new(),
                failure_requests: Vec::new(),
                fence_requests: Vec::new(),
                resync_required: BTreeSet::new(),
                fail_activation: false,
                fail_completion: false,
                fail_fence: false,
                source_counter: 0,
                reserve_gate: None,
                reap_pid_file: None,
                fence_saw_reaped: Vec::new(),
            })),
            fence_events: Arc::new(Semaphore::new(0)),
            reservation_events: Arc::new(Semaphore::new(0)),
            completion_events: Arc::new(Semaphore::new(0)),
            failure_events: Arc::new(Semaphore::new(0)),
        })
    }

    fn update_profile(&self, profile: InstalledPluginProfile) {
        self.lock().profile = profile;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn set_reserve_gate(&self, gate: Arc<Semaphore>) {
        self.lock().reserve_gate = Some(gate);
    }

    fn require_reap_before_fence(&self, pid_file: PathBuf) {
        self.lock().reap_pid_file = Some(pid_file);
    }

    async fn wait_fence(&self) {
        tokio::time::timeout(Duration::from_secs(3), self.fence_events.acquire())
            .await
            .expect("fence deadline")
            .expect("fence semaphore")
            .forget();
    }

    async fn wait_reservation(&self) {
        tokio::time::timeout(Duration::from_secs(3), self.reservation_events.acquire())
            .await
            .expect("reservation deadline")
            .expect("reservation semaphore")
            .forget();
    }

    async fn wait_completion(&self) {
        tokio::time::timeout(Duration::from_secs(3), self.completion_events.acquire())
            .await
            .expect("completion deadline")
            .expect("completion semaphore")
            .forget();
    }

    async fn wait_failure(&self) {
        tokio::time::timeout(Duration::from_secs(3), self.failure_events.acquire())
            .await
            .expect("failure deadline")
            .expect("failure semaphore")
            .forget();
    }

    fn open_fixture_sources(
        root: PathBuf,
        state: Arc<Mutex<MockState>>,
        selected: Vec<PluginComponentSelection>,
    ) -> Result<Vec<OpenedPluginComponentSource>, AppError> {
        let mut state = state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.counts.open_sources += 1;
        state.opened_selections.push(selected.clone());
        let plugins: BTreeMap<_, _> = state
            .profile
            .plugins
            .iter()
            .map(|plugin| (plugin.plugin_id.clone(), plugin.clone()))
            .collect();
        let mut opened = Vec::new();
        for selection in selected {
            let plugin = plugins
                .get(&selection.plugin_id)
                .ok_or(AppError::Conflict)?;
            if plugin.package_generation != selection.package_generation
                || plugin.activation_epoch != selection.activation_epoch
            {
                return Err(AppError::Conflict);
            }
            state.source_counter += 1;
            let path = root.join(format!("source-{}.bin", state.source_counter));
            let component = [u8::try_from(plugin.package_generation).unwrap_or(1)];
            fs::write(&path, [0_u8, component[0]]).map_err(|_| AppError::Storage)?;
            let file = File::open(path).map_err(|_| AppError::Storage)?;
            // This constructor models the already-verified AppService source port;
            // production supervisor code never calls it.
            let grants = plugin.manifest.permissions.clone();
            let permission_hash = canonical_permission_hash(&grants).expect("permission hash");
            let source = OpenedPluginComponentSource::from_verified_package_file(
                file,
                plugin.plugin_id.clone(),
                plugin.package_generation,
                plugin.activation_epoch,
                1,
                1,
                Sha256Digest::of(&component),
                plugin.manifest.runtime_profile,
                Sha256Digest::parse("2".repeat(64)).expect("fingerprint"),
                Sha256Digest::parse(permission_hash).expect("permission digest"),
                grants,
            )
            .map_err(|_| AppError::Storage)?;
            opened.push(source);
        }
        Ok(opened)
    }
}

impl Drop for MockService {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl RuntimeServicePort for MockService {
    fn profile(&self) -> ServiceFuture<InstalledPluginProfile> {
        let result = {
            let mut state = self.lock();
            state.counts.profile += 1;
            state.profile.clone()
        };
        Box::pin(async move { Ok(result) })
    }

    fn open_sources(
        &self,
        selected: Vec<PluginComponentSelection>,
    ) -> ServiceFuture<Vec<OpenedPluginComponentSource>> {
        let root = self.root.clone();
        let state = Arc::clone(&self.state);
        Box::pin(async move { Self::open_fixture_sources(root, state, selected) })
    }

    fn reconcile_packages(&self, _now: Timestamp) -> ServiceFuture<PluginPackageReconciliation> {
        self.lock().counts.reconcile_packages += 1;
        Box::pin(async {
            Ok(PluginPackageReconciliation {
                checked: 0,
                disabled: Vec::new(),
                orphan_files_removed: 0,
                cleanup_truncated: false,
            })
        })
    }

    fn retry_due(
        &self,
        _operation_id: OperationId,
        request: DuePluginRetryRequest,
        _now: Timestamp,
    ) -> ServiceFuture<()> {
        let result = {
            let mut state = self.lock();
            state.counts.due_retries += 1;
            state.due_requests.push(request.clone());
            let plugin = state
                .profile
                .plugins
                .iter_mut()
                .find(|plugin| plugin.plugin_id == request.plugin_id);
            match plugin {
                Some(plugin)
                    if plugin.package_generation == request.package_generation
                        && plugin.activation_epoch == request.activation_epoch
                        && plugin.runtime_state == request.expected_runtime_state
                        && plugin.next_retry_at == Some(request.expected_next_retry_at) =>
                {
                    plugin.activation_epoch += 1;
                    plugin.runtime_state = PluginRuntimeState::Starting;
                    plugin.next_retry_at = None;
                    Ok(())
                }
                _ => Err(AppError::Conflict),
            }
        };
        Box::pin(async move { result })
    }

    fn complete_activation(
        &self,
        _operation_id: OperationId,
        request: CompletePluginActivationRequest,
        _now: Timestamp,
    ) -> ServiceFuture<()> {
        let result = {
            let mut state = self.lock();
            state.counts.activations += 1;
            if state.fail_activation {
                Err(AppError::Conflict)
            } else {
                let plugin = state.profile.plugins.iter_mut().find(|plugin| {
                    plugin.plugin_id == request.plugin_id
                        && plugin.package_generation == request.package_generation
                        && plugin.activation_epoch == request.activation_epoch
                        && plugin.runtime_state == PluginRuntimeState::Starting
                });
                match plugin {
                    Some(plugin) => {
                        plugin.runtime_state = PluginRuntimeState::Active;
                        state.activation_order.push(request.plugin_id);
                        Ok(())
                    }
                    None => Err(AppError::Conflict),
                }
            }
        };
        Box::pin(async move { result })
    }

    fn cursor(&self, plugin_id: PluginId) -> ServiceFuture<PluginEventCursor> {
        let resync_required = self.lock().resync_required.contains(&plugin_id);
        Box::pin(async move {
            Ok(PluginEventCursor {
                plugin_id,
                event_epoch: "event-epoch".to_owned(),
                revision: 0,
                resync_required,
                updated_at: timestamp("2026-01-01T00:00:00Z"),
            })
        })
    }

    fn reserve_invocation(
        &self,
        request: ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> ServiceFuture<ReservedPluginInvocation> {
        let gate = {
            let mut state = self.lock();
            state.counts.reservations += 1;
            state.reserve_gate.clone()
        };
        self.reservation_events.add_permits(1);
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.acquire()
                    .await
                    .map_err(|_| AppError::Storage)?
                    .forget();
            }
            Ok(ReservedPluginInvocation::Reserved(PluginInvocation {
                operation_id: request.operation_id,
                plugin_id: request.plugin_id,
                package_generation: request.package_generation,
                activation_epoch: request.activation_epoch,
                hook_kind: request.hook_kind,
                entry: request.entry,
                request_sha256: request.request_sha256,
                delivery_operation_id: request.delivery_operation_id,
                state: PluginInvocationState::Reserved,
                error_code: None,
                created_at: now,
                updated_at: now,
                retain_until: now,
            }))
        })
    }

    fn complete_invocation(
        &self,
        _operation_id: OperationId,
        _plugin_id: PluginId,
        _package_generation: u64,
        _activation_epoch: u64,
        _now: Timestamp,
    ) -> ServiceFuture<CommittedPluginInvocation> {
        let fail = {
            let mut state = self.lock();
            state.counts.completions += 1;
            state.fail_completion
        };
        let completion_events = Arc::clone(&self.completion_events);
        Box::pin(async move {
            let result = if fail {
                Err(AppError::Conflict)
            } else {
                Ok(CommittedPluginInvocation {
                    terminal_kind: PluginInvocationTerminalKind::ReadOnly,
                    mutation: None,
                    cursor: None,
                    replayed: false,
                })
            };
            completion_events.add_permits(1);
            result
        })
    }

    fn record_failure(
        &self,
        _operation_id: OperationId,
        request: RecordPluginAttemptFailureRequest,
        _now: Timestamp,
    ) -> ServiceFuture<()> {
        let state = Arc::clone(&self.state);
        let failure_events = Arc::clone(&self.failure_events);
        Box::pin(async move {
            {
                let mut state = state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                state.counts.failures += 1;
                state.failure_requests.push(request.clone());
                if let Some(plugin) = state
                    .profile
                    .plugins
                    .iter_mut()
                    .find(|plugin| plugin.plugin_id == request.plugin_id)
                {
                    plugin.runtime_state = PluginRuntimeState::Degraded;
                    plugin.failure_count += 1;
                }
            }
            failure_events.add_permits(1);
            Ok(())
        })
    }

    fn fence_graph(&self, request: PluginGraphFenceRequest, _now: Timestamp) -> ServiceFuture<()> {
        let reaped = self.lock().reap_pid_file.clone().map(|path| {
            read_pids(&path)
                .last()
                .is_some_and(|pid| process_is_absent(*pid))
        });
        let result = {
            let mut state = self.lock();
            if let Some(reaped) = reaped {
                state.fence_saw_reaped.push(reaped);
            }
            state.fence_requests.push(request.clone());
            if state.fail_fence {
                Err(AppError::Conflict)
            } else {
                for entry in &request.entries {
                    let Some(plugin) = state
                        .profile
                        .plugins
                        .iter_mut()
                        .find(|plugin| plugin.plugin_id == entry.plugin_id)
                    else {
                        return Box::pin(async { Err(AppError::Conflict) });
                    };
                    if plugin.package_generation != entry.package_generation
                        || plugin.activation_epoch != entry.activation_epoch
                        || !plugin.desired_enabled
                        || !matches!(
                            plugin.runtime_state,
                            PluginRuntimeState::Starting | PluginRuntimeState::Active
                        )
                    {
                        return Box::pin(async { Err(AppError::Conflict) });
                    }
                    plugin.activation_epoch += 1;
                    plugin.runtime_state = PluginRuntimeState::Degraded;
                    plugin.failure_count += 1;
                }
                Ok(())
            }
        };
        self.fence_events.add_permits(1);
        Box::pin(async move { result })
    }
}

struct SqliteRuntimeService {
    service: AppService,
    source_root: PathBuf,
    source_counter: Arc<AtomicU64>,
    completion_gate: Arc<Semaphore>,
    completion_started: Arc<Semaphore>,
    completion_committed: Arc<Semaphore>,
    failure_started: Arc<Semaphore>,
    failure_committed: Arc<Semaphore>,
    fence_committed: Arc<Semaphore>,
    durable_order: Arc<Mutex<Vec<&'static str>>>,
    fence_requests: Arc<Mutex<Vec<PluginGraphFenceRequest>>>,
}

impl SqliteRuntimeService {
    fn new(service: AppService, source_root: PathBuf) -> Arc<Self> {
        fs::create_dir_all(&source_root).expect("SQLite source fixture root");
        Arc::new(Self {
            service,
            source_root,
            source_counter: Arc::new(AtomicU64::new(0)),
            completion_gate: Arc::new(Semaphore::new(0)),
            completion_started: Arc::new(Semaphore::new(0)),
            completion_committed: Arc::new(Semaphore::new(0)),
            failure_started: Arc::new(Semaphore::new(0)),
            failure_committed: Arc::new(Semaphore::new(0)),
            fence_committed: Arc::new(Semaphore::new(0)),
            durable_order: Arc::new(Mutex::new(Vec::new())),
            fence_requests: Arc::new(Mutex::new(Vec::new())),
        })
    }

    async fn wait(semaphore: &Semaphore, label: &str) {
        tokio::time::timeout(Duration::from_secs(3), semaphore.acquire())
            .await
            .unwrap_or_else(|_| panic!("{label} deadline"))
            .unwrap_or_else(|_| panic!("{label} semaphore"))
            .forget();
    }
}

impl RuntimeServicePort for SqliteRuntimeService {
    fn profile(&self) -> ServiceFuture<InstalledPluginProfile> {
        let service = self.service.clone();
        Box::pin(async move { service.get_installed_plugin_profile().await })
    }

    fn open_sources(
        &self,
        selected: Vec<PluginComponentSelection>,
    ) -> ServiceFuture<Vec<OpenedPluginComponentSource>> {
        let service = self.service.clone();
        let root = self.source_root.clone();
        let counter = Arc::clone(&self.source_counter);
        Box::pin(async move {
            let profile = service.get_installed_plugin_profile().await?;
            let mut opened = Vec::with_capacity(selected.len());
            for selection in selected {
                let plugin = profile
                    .plugins
                    .iter()
                    .find(|plugin| {
                        plugin.plugin_id == selection.plugin_id
                            && plugin.package_generation == selection.package_generation
                            && plugin.activation_epoch == selection.activation_epoch
                    })
                    .ok_or(AppError::Conflict)?;
                let index = counter.fetch_add(1, Ordering::Relaxed);
                let path = root.join(format!("source-{index}.bin"));
                let component = [u8::try_from(plugin.package_generation).unwrap_or(1)];
                fs::write(&path, [0_u8, component[0]]).map_err(|_| AppError::Storage)?;
                let file = File::open(path).map_err(|_| AppError::Storage)?;
                let grants = plugin.manifest.permissions.clone();
                let permission_hash =
                    canonical_permission_hash(&grants).ok_or(AppError::Storage)?;
                opened.push(
                    OpenedPluginComponentSource::from_verified_package_file(
                        file,
                        plugin.plugin_id.clone(),
                        plugin.package_generation,
                        plugin.activation_epoch,
                        1,
                        1,
                        Sha256Digest::of(&component),
                        plugin.manifest.runtime_profile,
                        Sha256Digest::parse("2".repeat(64)).map_err(|_| AppError::Storage)?,
                        Sha256Digest::parse(permission_hash).map_err(|_| AppError::Storage)?,
                        grants,
                    )
                    .map_err(|_| AppError::Storage)?,
                );
            }
            Ok(opened)
        })
    }

    fn reconcile_packages(&self, now: Timestamp) -> ServiceFuture<PluginPackageReconciliation> {
        let service = self.service.clone();
        Box::pin(async move { service.reconcile_plugin_packages(now).await })
    }

    fn retry_due(
        &self,
        operation_id: OperationId,
        request: DuePluginRetryRequest,
        now: Timestamp,
    ) -> ServiceFuture<()> {
        let service = self.service.clone();
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
        let service = self.service.clone();
        Box::pin(async move {
            service
                .complete_plugin_activation(operation_id, request, now)
                .await?;
            Ok(())
        })
    }

    fn cursor(&self, plugin_id: PluginId) -> ServiceFuture<PluginEventCursor> {
        let service = self.service.clone();
        Box::pin(async move { service.get_plugin_cursor(plugin_id).await })
    }

    fn reserve_invocation(
        &self,
        request: ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> ServiceFuture<ReservedPluginInvocation> {
        let service = self.service.clone();
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
        let service = self.service.clone();
        let gate = Arc::clone(&self.completion_gate);
        let started = Arc::clone(&self.completion_started);
        let committed = Arc::clone(&self.completion_committed);
        let order = Arc::clone(&self.durable_order);
        Box::pin(async move {
            started.add_permits(1);
            gate.acquire()
                .await
                .map_err(|_| AppError::Storage)?
                .forget();
            let result = service
                .complete_plugin_invocation(
                    operation_id,
                    plugin_id,
                    package_generation,
                    activation_epoch,
                    now,
                )
                .await;
            if result.is_ok() {
                order.lock().unwrap().push("complete");
                committed.add_permits(1);
            }
            result
        })
    }

    fn record_failure(
        &self,
        operation_id: OperationId,
        request: RecordPluginAttemptFailureRequest,
        now: Timestamp,
    ) -> ServiceFuture<()> {
        let service = self.service.clone();
        let started = Arc::clone(&self.failure_started);
        let committed = Arc::clone(&self.failure_committed);
        let order = Arc::clone(&self.durable_order);
        Box::pin(async move {
            started.add_permits(1);
            let result = service
                .record_plugin_attempt_failure(operation_id, request, now)
                .await;
            if result.is_ok() {
                order.lock().unwrap().push("failure");
                committed.add_permits(1);
            }
            result.map(|_| ())
        })
    }

    fn fence_graph(&self, request: PluginGraphFenceRequest, now: Timestamp) -> ServiceFuture<()> {
        let service = self.service.clone();
        let requests = Arc::clone(&self.fence_requests);
        let committed = Arc::clone(&self.fence_committed);
        Box::pin(async move {
            requests.lock().unwrap().push(request.clone());
            let result = service.fence_plugin_graph(request, now).await;
            if result.is_ok() {
                committed.add_permits(1);
            }
            result.map(|_| ())
        })
    }
}

fn seed_sqlite_active_plugins(profile_dir: &Path, count: usize) {
    let mut connection = Connection::open(profile_dir.join("junban.sqlite3")).unwrap();
    let transaction = connection.transaction().unwrap();
    let now = "2020-01-01T00:00:00Z";
    transaction
        .execute(
            "INSERT INTO plugin_publisher_trust(
                key_id, public_key, status, trusted_at, revoked_at
             ) VALUES (?1, ?2, 'active', ?3, NULL)",
            params!["1".repeat(64), vec![0_u8; 32], now],
        )
        .unwrap();
    for index in 0..count {
        let id = format!("plugin-{index:02}");
        let generation = u64::try_from(index + 1).unwrap();
        let component = [u8::try_from(generation).unwrap_or(1)];
        let mut manifest = manifest(&id, Vec::new());
        let permission = Permission {
            capability: Capability::Commands,
            scope: PermissionScope::Unscoped(UnscopedPermission {}),
        };
        manifest.permissions = vec![permission.clone()];
        manifest.component_sha256 = Sha256Digest::of(&component).to_string();
        let permission_hash = Sha256Digest::from_bytes(
            permission_set_hash(&manifest.permissions).expect("permission set hash"),
        );
        transaction
            .execute(
                "INSERT INTO plugins(
                    plugin_id, package_generation, activation_epoch, package_sha256,
                    component_sha256, publisher_key_id, version, manifest_json,
                    permission_hash, compatibility, desired_enabled, runtime_state,
                    failure_count, last_error_code, next_retry_at, installed_at, updated_at
                 ) VALUES (?1, ?2, 10, ?3, ?4, ?5, '1.0.0', ?6, ?7, '^0.1.0',
                           1, 'active', 0, NULL, NULL, ?8, ?8)",
                params![
                    id,
                    i64::try_from(generation).unwrap(),
                    Sha256Digest::of(format!("package-{index}").as_bytes()).to_string(),
                    manifest.component_sha256,
                    "1".repeat(64),
                    serde_json::to_string(&manifest).unwrap(),
                    permission_hash.to_string(),
                    now,
                ],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_grants(
                    plugin_id, package_generation, capability, scope_json, scope_hash,
                    permission_hash, granted_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    i64::try_from(generation).unwrap(),
                    permission.capability.as_str(),
                    serde_json::to_string(&permission.scope).unwrap(),
                    Sha256Digest::from_bytes(scope_hash(&permission).unwrap()).to_string(),
                    permission_hash.to_string(),
                    now,
                ],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_event_cursors(
                    plugin_id, event_epoch, revision, resync_required, updated_at
                 ) VALUES (?1, ?2, 0, 0, ?3)",
                params![id, Uuid::nil().to_string(), now],
            )
            .unwrap();
    }
    transaction.commit().unwrap();
}

fn sqlite_app_service(owner: &ProfileOwner) -> AppService {
    let sink = BroadcastEventSink::new(16, Arc::new(ReminderWakeHub::new()));
    junban_app::TaskService::new(Arc::new(owner.repository()), Arc::new(sink))
}

fn test_deadlines() -> ProcessDeadlines {
    ProcessDeadlines {
        control: Duration::from_millis(300),
        compile_load: Duration::from_millis(300),
    }
}

#[cfg(unix)]
struct HostFixture {
    root: PathBuf,
    executable: PathBuf,
    pid_file: PathBuf,
    capture_file: PathBuf,
    violation_file: PathBuf,
}

#[cfg(unix)]
impl HostFixture {
    fn new(label: &str, config: Value) -> Self {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_root(&format!("host-{label}"));
        fs::create_dir_all(&root).expect("host fixture root");
        let config_path = root.join("config.json");
        fs::write(
            &config_path,
            serde_json::to_vec(&config).expect("fixture config"),
        )
        .expect("write fixture config");
        let executable = root.join("fixture-host");
        let root_literal = serde_json::to_string(root.to_str().expect("utf8 root")).unwrap();
        let script = PYTHON_HOST.replace("__ROOT__", &root_literal);
        fs::write(&executable, script).expect("write fixture host");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("fixture permissions");
        Self {
            pid_file: root.join("pids"),
            capture_file: root.join("capture.jsonl"),
            violation_file: root.join("old-process-alive"),
            root,
            executable,
        }
    }

    fn policy(
        &self,
        sessions: Vec<Uuid>,
        launched_pids: Arc<Mutex<Vec<u32>>>,
    ) -> PluginHostLaunchPolicy {
        PluginHostLaunchPolicy::explicit(
            self.executable.clone(),
            test_deadlines(),
            sessions,
            launched_pids,
        )
    }

    fn captured_frames(&self) -> Vec<Value> {
        let Ok(bytes) = fs::read(&self.capture_file) else {
            return Vec::new();
        };
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<Value>(line).expect("capture line"))
            .collect()
    }
}

#[cfg(unix)]
impl Drop for HostFixture {
    fn drop(&mut self) {
        for pid in read_pids(&self.pid_file) {
            if !process_is_absent(pid) {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
const PYTHON_HOST: &str = r#"#!/usr/bin/python3
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import sys

ROOT = Path(__ROOT__)
CFG = json.loads((ROOT / "config.json").read_text())
COUNTER = ROOT / "launch-counter"
launch = int(COUNTER.read_text()) if COUNTER.exists() else 0
COUNTER.write_text(str(launch + 1))
PID_FILE = ROOT / "pids"
old_pids = [int(value) for value in PID_FILE.read_text().split()] if PID_FILE.exists() else []
if old_pids:
    try:
        os.kill(old_pids[-1], 0)
        (ROOT / "old-process-alive").write_text(str(old_pids[-1]))
    except ProcessLookupError:
        pass
with PID_FILE.open("a") as output:
    output.write(str(os.getpid()) + "\n")

stdin = sys.stdin.buffer
stdout = sys.stdout.buffer
capture = ROOT / "capture.jsonl"
invocations = {}

def exact(count):
    data = bytearray()
    while len(data) < count:
        part = stdin.read(count - len(data))
        if not part:
            raise EOFError()
        data.extend(part)
    return bytes(data)

def read_message():
    try:
        size = struct.unpack(">I", exact(4))[0]
    except EOFError:
        return None, b""
    frame = json.loads(exact(size))
    body_size = frame.get("component_size", frame.get("request_size", frame.get("response_size", 0)))
    body = exact(body_size) if body_size else b""
    with capture.open("a") as output:
        output.write(json.dumps({"launch": launch, "frame": frame}, separators=(",", ":")) + "\n")
    return frame, body

def send(frame, body=b""):
    header = json.dumps(frame, separators=(",", ":")).encode()
    stdout.write(struct.pack(">I", len(header)))
    stdout.write(header)
    stdout.write(body)
    stdout.flush()

def outcome_body(kind):
    tag = kind.replace("_", "-")
    if kind in ("invoke_command", "handle_event", "handle_surface_action"):
        value = {"tag": "ok", "val": {"effect": None}}
    elif kind == "call_service":
        value = {"tag": "ok", "val": {"values": []}}
    elif kind == "activate" or kind == "deactivate":
        value = {"tag": "ok", "val": None}
    else:
        value = {"tag": "err", "val": {"code": "unavailable", "field": None, "message": "fixture"}}
    return json.dumps({"tag": tag, "val": value}, separators=(",", ":")).encode()

def send_outcome(invoke, mode="success"):
    fence = copy.deepcopy(invoke["fence"])
    kind = invoke["kind"]
    body = outcome_body(kind)
    if mode == "wrong_plugin":
        fence["plugin_id"] = "other-plugin"
    elif mode == "wrong_generation":
        fence["package_generation"] += 1
    elif mode == "wrong_epoch":
        fence["activation_epoch"] += 1
    elif mode == "wrong_session":
        fence["host_session_id"] = "00000000-0000-4000-9000-999999999999"
    elif mode == "wrong_invocation":
        fence["invocation_id"] = "00000000-0000-4000-8000-999999999999"
    if mode == "wrong_kind":
        kind = "handle_event"
    if mode == "malformed_body":
        body = b"{"
    frame = {
        "type": "outcome",
        "fence": fence,
        "kind": kind,
        "outcome_sha256": hashlib.sha256(body).hexdigest(),
        "outcome_size": len(body),
    }
    if mode == "partial_body":
        header = json.dumps(frame, separators=(",", ":")).encode()
        stdout.write(struct.pack(">I", len(header)))
        stdout.write(header)
        stdout.write(body[:-1])
        stdout.flush()
        stdin.read(1)
    else:
        send(frame, body)

def send_callback(invoke, mode):
    fence = invoke["fence"]
    callback = {
        "plugin_id": fence["plugin_id"],
        "package_generation": fence["package_generation"],
        "activation_epoch": fence["activation_epoch"],
        "host_session_id": fence["host_session_id"],
        "invocation_id": fence["invocation_id"],
        "callback_id": 1,
    }
    if mode == "callback_wrong_id":
        callback["callback_id"] = 2
    if mode == "service_callback":
        body = b'{"tag":"call-service","val":{"plugin-id":"service-target","service-id":"service","values":[]}}'
        kind = "call_service"
    else:
        body = b'{"tag":"monotonic-ms","val":null}'
        kind = "monotonic_ms"
    send({
        "type": "capability_request",
        "callback": callback,
        "kind": kind,
        "request_sha256": hashlib.sha256(body).hexdigest(),
        "request_size": len(body),
    }, body)

hello, _ = read_message()
hello_mode = CFG.get("hello", "valid")
if hello_mode == "stalled":
    stdin.read(1)
    sys.exit(0)
if hello_mode == "partial":
    stdout.write(struct.pack(">I", 100) + b'{')
    stdout.flush()
    stdin.read(1)
    sys.exit(0)
if hello_mode == "malformed":
    stdout.write(struct.pack(">I", 1) + b'{')
    stdout.flush()
    sys.exit(0)
if hello_mode == "wrong_product":
    hello["junban_version"] = "999.0.0"
send(hello)

loads_by_launch = CFG.get("loads_by_launch", [CFG.get("loads", 0)])
load_count = loads_by_launch[min(launch, len(loads_by_launch) - 1)]
for _ in range(load_count):
    frame, _ = read_message()
    if frame is None or frame.get("type") != "load":
        sys.exit(2)
    if CFG.get("load_failure") == frame["fence"]["plugin_id"]:
        send({"type": "failed", "fence": frame["fence"], "code": "invalid_component"})
        # Keep EOF from racing the acknowledged failure frame. The parent
        # closes stdin while performing its bounded kill/reap.
        stdin.read(1)
        sys.exit(0)
    send({
        "type": "loaded",
        "fence": frame["fence"],
        "import_export_fingerprint": frame["import_export_fingerprint"],
    })
with (ROOT / "ready").open("a") as output:
    output.write(str(launch) + "\n")

runtime_fault = CFG.get("runtime_fault")
if runtime_fault == "idle_exit":
    sys.exit(0)
if runtime_fault == "malformed":
    stdout.write(struct.pack(">I", 1) + b'{')
    stdout.flush()
    sys.exit(0)
if runtime_fault == "partial":
    stdout.write(struct.pack(">I", 100) + b'{')
    stdout.flush()
    stdin.read(1)
    sys.exit(0)
if runtime_fault == "stalled":
    stdin.read(1)
    sys.exit(0)

while True:
    frame, _ = read_message()
    if frame is None:
        break
    kind = frame.get("type")
    if kind == "invoke":
        invocation_id = frame["fence"]["invocation_id"]
        invocations[invocation_id] = frame
        modes = CFG.get("invoke_modes", {})
        mode = modes.get(frame["fence"]["plugin_id"], CFG.get("invoke", "success"))
        if mode == "guest_error":
            send({"type": "failed", "fence": frame["fence"], "code": "guest_error"})
        elif mode in ("callback", "callback_wrong_id", "service_callback"):
            send_callback(frame, mode)
        elif mode != "hold":
            send_outcome(frame, mode)
    elif kind == "cancel":
        invoke = invocations.get(frame["fence"]["invocation_id"])
        if invoke is not None:
            if CFG.get("cancel", "cancelled") == "late_outcome":
                send_outcome(invoke)
            else:
                send({"type": "cancelled", "fence": invoke["fence"]})
    elif kind == "capability_reply":
        invoke = invocations.get(frame["callback"]["invocation_id"])
        if invoke is not None:
            send_outcome(invoke)
    elif kind == "shutdown":
        if CFG.get("shutdown", "graceful") == "forced":
            stdin.read(1)
        else:
            send({"type": "shutdown_complete", "host_session_id": frame["host_session_id"]})
        break
"#;

fn unique_root(label: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let index = NEXT.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "junban-plugin-runtime-{label}-{}-{index}",
        std::process::id()
    ))
}

fn read_pids(path: &Path) -> Vec<u32> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.parse().ok())
        .collect()
}

async fn wait_pids_reaped(path: &Path) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if read_pids(path).iter().all(|pid| process_is_absent(*pid)) {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("process reap deadline");
}

async fn wait_active_invocations(
    supervisor: &PluginRuntimeSupervisor,
    expected: usize,
) -> PluginRuntimeSnapshot {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let snapshot = supervisor.snapshot().await.expect("runtime snapshot");
            if snapshot.active_invocations == expected {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("invocation release deadline")
}

#[cfg(unix)]
async fn wait_for_captured_frame(fixture: &HostFixture, frame_type: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let captured = fs::read(&fixture.capture_file).unwrap_or_default();
            if captured.split(|byte| *byte == b'\n').any(|line| {
                serde_json::from_slice::<Value>(line)
                    .ok()
                    .is_some_and(|capture| capture["frame"]["type"] == frame_type)
            }) {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture frame acknowledgement deadline");
}

fn process_is_absent(pid: u32) -> bool {
    #[cfg(unix)]
    {
        !Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("process probe")
            .success()
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn dispatch(plugin: &InstalledPlugin, index: u64) -> PluginInvocationDispatch {
    let request = InvocationRequest::invoke_command(
        Some("command".to_owned()),
        CommandCall {
            command_id: "command".to_owned(),
            values: Vec::new(),
        },
    );
    let (_, body) = request
        .clone()
        .into_parent_message(
            AuthorityFence {
                plugin_id: plugin.plugin_id.to_string(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: session(999).to_string(),
                invocation_id: operation(index).to_string(),
            },
            canonical_permission_hash(&[]).expect("permission hash"),
        )
        .expect("fixture invocation")
        .into_parts();
    PluginInvocationDispatch {
        reservation: ReservePluginInvocationRequest {
            operation_id: operation(index),
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("command").expect("command id"),
            },
            request_sha256: Sha256Digest::of(&body),
            delivery_operation_id: operation(index + 10_000),
            resync_session: None,
        },
        request,
    }
}

fn loaded_node(plugin: InstalledPlugin) -> LoadedNode {
    LoadedNode {
        load_frame: ParentFrame::Load {
            fence: AuthorityFence {
                plugin_id: plugin.plugin_id.to_string(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: session(1).to_string(),
                invocation_id: operation(1).to_string(),
            },
            package_sha256: plugin.package_sha256.to_string(),
            component_sha256: plugin.component_sha256.to_string(),
            import_export_fingerprint: "2".repeat(64),
            runtime_profile: RuntimeProfile::Typescript,
            component_size: 1,
            grants: Vec::new(),
            permission_hash: canonical_permission_hash(&[]).expect("permission hash"),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
        },
        plugin,
        admitting: true,
    }
}

#[tokio::test]
async fn construction_and_empty_reconciliation_are_truly_dormant() {
    let service = MockService::new("dormant", chain_profile(0, PluginRuntimeState::Active));
    let launched = Arc::new(Mutex::new(Vec::new()));
    let policy = PluginHostLaunchPolicy::explicit(
        PathBuf::from("/must/not/be/inspected"),
        test_deadlines(),
        Vec::new(),
        Arc::clone(&launched),
    );
    let supervisor =
        PluginRuntimeSupervisor::for_test(service.clone(), policy, Arc::new(DenyCallbacks));

    assert_eq!(
        supervisor.snapshot().await.unwrap(),
        PluginRuntimeSnapshot::dormant()
    );
    assert_eq!(
        supervisor.reconcile().await.unwrap(),
        PluginRuntimeSnapshot::dormant()
    );
    assert_eq!(
        supervisor.snapshot().await.unwrap(),
        PluginRuntimeSnapshot::dormant()
    );
    supervisor.restore_dormant().await.unwrap();
    let mut retrying = chain_profile(1, PluginRuntimeState::Degraded);
    retrying.plugins[0].failure_count = 1;
    retrying.plugins[0].next_retry_at = Some(timestamp("2099-01-01T00:00:00Z"));
    service.update_profile(retrying);
    assert_eq!(
        supervisor.reconcile().await.unwrap(),
        PluginRuntimeSnapshot::dormant()
    );
    assert!(launched.lock().unwrap().is_empty());
    let state = service.lock();
    assert_eq!(state.counts.profile, 3);
    assert_eq!(state.counts.open_sources, 0);
    assert_eq!(state.counts.due_retries, 0);
    assert!(state.fence_requests.is_empty());
}

#[tokio::test]
async fn seventeen_plugins_are_rejected_before_source_or_process_work() {
    let service = MockService::new("graph-bound", chain_profile(17, PluginRuntimeState::Active));
    let launched = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        PluginHostLaunchPolicy::explicit(
            PathBuf::from("/must/not/be/inspected"),
            test_deadlines(),
            vec![session(2)],
            Arc::clone(&launched),
        ),
        Arc::new(DenyCallbacks),
    );
    assert_eq!(
        supervisor.reconcile().await,
        Err(PluginRuntimeError::AuthorityRejected)
    );
    let state = service.lock();
    assert_eq!(state.counts.open_sources, 0);
    assert!(state.fence_requests.is_empty());
    assert!(launched.lock().unwrap().is_empty());
}

#[test]
fn dependency_order_bound_and_graph_fence_shapes_are_exact() {
    let base = installed_plugin("z-base", 1, 7, PluginRuntimeState::Starting, Vec::new());
    let dependent = installed_plugin(
        "a-dependent",
        2,
        8,
        PluginRuntimeState::Active,
        vec![Dependency {
            id: "z-base".to_owned(),
            requirement: "^1.0.0".to_owned(),
            services: Vec::new(),
        }],
    );
    let sibling = installed_plugin("m-sibling", 3, 9, PluginRuntimeState::Active, Vec::new());
    let graph_profile = profile(
        vec![dependent.clone(), sibling.clone(), base.clone()],
        vec!["z-base", "a-dependent", "m-sibling"],
    );
    let plan = RuntimePlan::from_profile(graph_profile).unwrap();
    assert_eq!(
        plan.selected
            .iter()
            .map(|plugin| plugin.plugin_id.as_str())
            .collect::<Vec<_>>(),
        ["z-base", "a-dependent", "m-sibling"]
    );
    assert!(RuntimePlan::from_profile(chain_profile(16, PluginRuntimeState::Active)).is_ok());
    assert!(matches!(
        RuntimePlan::from_profile(chain_profile(17, PluginRuntimeState::Active)),
        Err(PluginRuntimeError::AuthorityRejected)
    ));

    let graph = vec![base, dependent, sibling];
    let triggered = graph_fence_entries(
        &graph,
        Some((
            PluginId::parse("z-base").unwrap(),
            PluginGraphFenceCause::CompileLoad,
        )),
    );
    assert_eq!(triggered.len(), 3);
    assert!(
        triggered
            .windows(2)
            .all(|pair| pair[0].plugin_id < pair[1].plugin_id)
    );
    assert_eq!(
        triggered
            .iter()
            .filter(|entry| entry.disposition == PluginGraphFenceDisposition::Failing)
            .count(),
        1
    );
    assert!(triggered.iter().any(|entry| {
        entry.plugin_id.as_str() == "a-dependent"
            && entry.disposition == PluginGraphFenceDisposition::SkippedDependent
            && entry.cause == PluginGraphFenceCause::DependencyFailed
    }));
    assert!(triggered.iter().any(|entry| {
        entry.plugin_id.as_str() == "m-sibling"
            && entry.disposition == PluginGraphFenceDisposition::LoadedSibling
            && entry.cause == PluginGraphFenceCause::SessionLost
    }));

    let triggerless = graph_fence_entries(&graph, None);
    assert!(triggerless.iter().all(|entry| {
        entry.disposition == PluginGraphFenceDisposition::LoadedSibling
            && entry.cause == PluginGraphFenceCause::SessionLost
    }));
}

#[tokio::test]
async fn parent_admission_enforces_four_per_plugin_cycles_and_depth_eight() {
    let service = MockService::new("admission", chain_profile(0, PluginRuntimeState::Active));
    let (_commands, receiver) = mpsc::channel(1);
    let mut actor = RuntimeActor::new(
        service,
        PluginHostLaunchPolicy::default(),
        Arc::new(DenyCallbacks),
        Arc::new(AtomicBool::new(false)),
        receiver,
    );
    actor.lifecycle = PluginRuntimeLifecycle::Running;
    actor.host_session_id = Some(session(1).to_string());
    for index in 0..5 {
        let plugin = installed_plugin(
            &format!("admit-{index}"),
            u64::try_from(index + 1).unwrap(),
            1,
            PluginRuntimeState::Active,
            Vec::new(),
        );
        actor
            .nodes
            .insert(plugin.plugin_id.clone(), loaded_node(plugin));
    }
    let target = PluginId::parse("admit-4").unwrap();
    assert_eq!(
        actor.check_invocation_admission(&target, false, &[], 8),
        Ok(())
    );
    assert_eq!(
        actor.check_invocation_admission(&target, false, &[], 9),
        Err(PluginRuntimeError::ServiceDepth)
    );
    assert_eq!(
        actor.check_invocation_admission(&target, false, std::slice::from_ref(&target), 1),
        Err(PluginRuntimeError::ReentrantService)
    );
    assert_eq!(
        actor.check_invocation_admission(
            &target,
            false,
            &[target.clone(), PluginId::parse("admit-0").unwrap()],
            2,
        ),
        Err(PluginRuntimeError::ServiceCycle)
    );

    for index in 0..4 {
        let plugin_id = PluginId::parse(format!("admit-{index}")).unwrap();
        let plugin = actor.nodes.get(&plugin_id).unwrap().plugin.clone();
        let dispatch = dispatch(&plugin, u64::try_from(index + 1).unwrap());
        let request = dispatch.request;
        let permission_hash = canonical_permission_hash(&[]).unwrap();
        let fence = AuthorityFence {
            plugin_id: plugin_id.to_string(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            host_session_id: session(1).to_string(),
            invocation_id: operation(u64::try_from(index + 1).unwrap()).to_string(),
        };
        let (invoke_frame, body) = request
            .clone()
            .into_parent_message(fence.clone(), permission_hash)
            .unwrap()
            .into_parts();
        actor.invocations.insert(
            operation(u64::try_from(index + 1).unwrap()),
            InvocationRecord {
                operation_id: operation(u64::try_from(index + 1).unwrap()),
                plugin_id,
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                fence,
                kind: request.kind(),
                invoke_frame,
                body,
                phase: InvocationPhase::Running,
                ancestry: Vec::new(),
                service_depth: 0,
                next_callback_id: 1,
                expected_callback: None,
                deadline: None,
                awaiting_child_terminal: false,
                cancel_requested: Arc::new(AtomicBool::new(false)),
                terminal: None,
                nested_parent: None,
                durable: false,
            },
        );
    }
    assert_eq!(
        actor.check_invocation_admission(&target, false, &[], 0),
        Err(PluginRuntimeError::InvocationLimit)
    );
    let busy = PluginId::parse("admit-0").unwrap();
    actor.invocations.remove(&operation(4));
    assert_eq!(
        actor.check_invocation_admission(&busy, false, &[], 0),
        Err(PluginRuntimeError::PluginBusy)
    );
}

#[cfg(unix)]
#[tokio::test]
async fn dependency_first_one_pid_loads_every_graph_size_one_through_sixteen() {
    for count in 1..=16 {
        let fixture = HostFixture::new(
            &format!("load-{count}"),
            json!({"loads": count, "shutdown": "graceful"}),
        );
        let service = MockService::new(
            &format!("load-{count}"),
            chain_profile(count, PluginRuntimeState::Starting),
        );
        let pids = Arc::new(Mutex::new(Vec::new()));
        let supervisor = PluginRuntimeSupervisor::for_test(
            service.clone(),
            fixture.policy(
                vec![session(u64::try_from(count).unwrap())],
                Arc::clone(&pids),
            ),
            Arc::new(DenyCallbacks),
        );
        let snapshot = supervisor.reconcile().await.unwrap();
        assert_eq!(snapshot.lifecycle, PluginRuntimeLifecycle::Running);
        assert_eq!(snapshot.graph_size, count);
        assert_eq!(snapshot.admitting_plugins.len(), count);
        assert_eq!(pids.lock().unwrap().len(), 1);
        {
            let state = service.lock();
            assert_eq!(state.counts.activations, count);
            assert_eq!(state.activation_order, state.profile.activation_order);
            assert_eq!(state.opened_selections.len(), 1);
            assert!(
                state.opened_selections[0]
                    .windows(2)
                    .all(|pair| pair[0].plugin_id < pair[1].plugin_id)
            );
        }
        supervisor.shutdown().await.unwrap();
        let pid = pids.lock().unwrap()[0];
        assert!(process_is_absent(pid));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn source_sorting_cannot_change_dependency_first_wire_order() {
    let base = installed_plugin("z-base", 1, 3, PluginRuntimeState::Starting, Vec::new());
    let dependent = installed_plugin(
        "a-dependent",
        2,
        3,
        PluginRuntimeState::Starting,
        vec![Dependency {
            id: "z-base".to_owned(),
            requirement: "^1.0.0".to_owned(),
            services: Vec::new(),
        }],
    );
    let service = MockService::new(
        "dependency-wire",
        profile(vec![dependent, base], vec!["z-base", "a-dependent"]),
    );
    let fixture = HostFixture::new("dependency-wire", json!({"loads": 2}));
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service,
        fixture.policy(vec![session(30)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    supervisor.shutdown().await.unwrap();
    let load_ids: Vec<_> = fixture
        .captured_frames()
        .into_iter()
        .filter_map(|capture| {
            let frame = &capture["frame"];
            (frame["type"] == "load")
                .then(|| frame["fence"]["plugin_id"].as_str().unwrap().to_owned())
        })
        .collect();
    assert_eq!(load_ids, ["z-base", "a-dependent"]);
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn reconfigure_reaps_the_old_graph_before_spawning_its_replacement() {
    let fixture = HostFixture::new(
        "reconfigure",
        json!({"loads_by_launch": [1, 1], "shutdown": "graceful"}),
    );
    let service = MockService::new(
        "reconfigure",
        chain_profile(1, PluginRuntimeState::Starting),
    );
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(40), session(41)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let mut replacement = chain_profile(1, PluginRuntimeState::Starting);
    replacement.plugins[0].activation_epoch += 1;
    service.update_profile(replacement);
    supervisor.reconcile().await.unwrap();
    let pids = pids.lock().unwrap().clone();
    assert_eq!(pids.len(), 2);
    assert!(process_is_absent(pids[0]));
    assert!(!fixture.violation_file.exists());
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids[1]));
}

#[cfg(unix)]
#[tokio::test]
async fn stopping_actor_blocks_reconcile_until_the_child_is_reaped() {
    let fixture = HostFixture::new("stop-reconcile", json!({"loads": 1, "shutdown": "forced"}));
    let service = MockService::new(
        "stop-reconcile",
        chain_profile(1, PluginRuntimeState::Active),
    );
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = Arc::new(PluginRuntimeSupervisor::for_test(
        service,
        fixture.policy(vec![session(45)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    ));
    supervisor.reconcile().await.unwrap();

    let stopping = Arc::clone(&supervisor);
    let stop = tokio::spawn(async move { stopping.shutdown().await });
    wait_for_captured_frame(&fixture, "shutdown").await;
    assert_eq!(
        supervisor.reconcile().await,
        Err(PluginRuntimeError::Closed)
    );
    assert_eq!(pids.lock().unwrap().len(), 1);
    assert_eq!(stop.await.unwrap(), Err(PluginRuntimeError::Closed));
    assert!(process_is_absent(pids.lock().unwrap()[0]));
    assert!(!fixture.violation_file.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn retained_invocation_handle_cannot_own_the_actor_or_child_lifetime() {
    let fixture = HostFixture::new(
        "retained-handle",
        json!({"loads": 1, "invoke": "hold", "cancel": "cancelled"}),
    );
    let service = MockService::new(
        "retained-handle",
        chain_profile(1, PluginRuntimeState::Active),
    );
    let plugin = service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service,
        fixture.policy(vec![session(46)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let handle = supervisor.invoke(dispatch(&plugin, 46)).await.unwrap();

    drop(supervisor);
    wait_pids_reaped(&fixture.pid_file).await;
    assert!(matches!(
        handle.outcome().await.unwrap(),
        InvocationOutcome::Cancelled
    ));
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn duplicate_operation_id_is_rejected_across_two_plugins() {
    let fixture = HostFixture::new(
        "duplicate-operation",
        json!({"loads": 2, "invoke": "hold", "cancel": "cancelled"}),
    );
    let service = MockService::new(
        "duplicate-operation",
        chain_profile(2, PluginRuntimeState::Active),
    );
    let gate = Arc::new(Semaphore::new(0));
    service.set_reserve_gate(Arc::clone(&gate));
    let plugins = service.lock().profile.plugins.clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(47)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let first = supervisor.invoke(dispatch(&plugins[0], 47)).await.unwrap();
    service.wait_reservation().await;
    let mut live_collision = dispatch(&plugins[1], 48);
    live_collision.reservation.operation_id = operation(47);
    assert!(matches!(
        supervisor.invoke(live_collision).await,
        Err(PluginRuntimeError::AuthorityRejected)
    ));
    first.cancel();
    assert!(matches!(
        first.outcome().await.unwrap(),
        InvocationOutcome::Cancelled
    ));
    let mut cancelled_collision = dispatch(&plugins[1], 49);
    cancelled_collision.reservation.operation_id = operation(47);
    assert!(matches!(
        supervisor.invoke(cancelled_collision).await,
        Err(PluginRuntimeError::AuthorityRejected)
    ));
    assert_eq!(service.lock().counts.reservations, 1);
    gate.add_permits(1);
    service.wait_completion().await;
    wait_active_invocations(&supervisor, 0).await;
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn parent_four_total_and_per_plugin_limits_hold_without_child_trust() {
    let fixture = HostFixture::new(
        "parent-limits",
        json!({"loads": 4, "invoke": "hold", "cancel": "cancelled"}),
    );
    let service = MockService::new(
        "parent-limits",
        chain_profile(4, PluginRuntimeState::Active),
    );
    let plugins = service.lock().profile.plugins.clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(50)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let first = supervisor.invoke(dispatch(&plugins[0], 100)).await.unwrap();
    assert!(matches!(
        supervisor.invoke(dispatch(&plugins[0], 101)).await,
        Err(PluginRuntimeError::PluginBusy)
    ));
    let second = supervisor.invoke(dispatch(&plugins[1], 102)).await.unwrap();
    let third = supervisor.invoke(dispatch(&plugins[2], 103)).await.unwrap();
    let fourth = supervisor.invoke(dispatch(&plugins[3], 104)).await.unwrap();
    assert!(matches!(
        supervisor.invoke(dispatch(&plugins[0], 105)).await,
        Err(PluginRuntimeError::InvocationLimit)
    ));
    assert_eq!(supervisor.snapshot().await.unwrap().active_invocations, 4);
    drop((first, second, third, fourth));
    // A cancellation burst may find the intentionally four-slot driver full;
    // that bounded fail-closed path must fence and reap rather than detach.
    assert_eq!(supervisor.shutdown().await, Err(PluginRuntimeError::Closed));
    assert_eq!(service.lock().fence_requests.len(), 1);
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn stale_invocation_completion_cas_fences_and_reaps_without_graph_mutation() {
    let fixture = HostFixture::new("stale-completion", json!({"loads": 1, "invoke": "success"}));
    let service = MockService::new(
        "stale-completion",
        chain_profile(1, PluginRuntimeState::Active),
    );
    service.lock().fail_completion = true;
    let plugin = service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(59)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    assert!(matches!(
        supervisor
            .invoke(dispatch(&plugin, 199))
            .await
            .unwrap()
            .outcome()
            .await
            .unwrap(),
        InvocationOutcome::Failed(InvocationFailure::AuthorityRejected)
    ));
    service.wait_completion().await;
    assert_eq!(
        supervisor.snapshot().await.unwrap().lifecycle,
        PluginRuntimeLifecycle::Fenced
    );
    wait_pids_reaped(&fixture.pid_file).await;
    assert!(service.lock().fence_requests.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn resync_and_stale_activation_cas_never_open_admission() {
    let fixture = HostFixture::new(
        "resync-cas",
        json!({"loads_by_launch": [1, 1], "shutdown": "graceful"}),
    );
    let service = MockService::new("resync-cas", chain_profile(1, PluginRuntimeState::Starting));
    let plugin_id = service.lock().profile.plugins[0].plugin_id.clone();
    service.lock().resync_required.insert(plugin_id.clone());
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(60), session(61)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    let snapshot = supervisor.reconcile().await.unwrap();
    assert!(snapshot.admitting_plugins.is_empty());
    assert_eq!(service.lock().counts.activations, 0);
    let plugin = service.lock().profile.plugins[0].clone();
    assert!(matches!(
        supervisor.invoke(dispatch(&plugin, 200)).await,
        Err(PluginRuntimeError::NotAdmitting)
    ));
    supervisor.shutdown().await.unwrap();

    service.lock().resync_required.clear();
    service.lock().fail_activation = true;
    service.update_profile(chain_profile(1, PluginRuntimeState::Starting));
    assert_eq!(
        supervisor.reconcile().await,
        Err(PluginRuntimeError::AuthorityRejected)
    );
    assert_eq!(
        supervisor.snapshot().await.unwrap().lifecycle,
        PluginRuntimeLifecycle::Fenced
    );
    wait_pids_reaped(&fixture.pid_file).await;
}

#[cfg(unix)]
#[tokio::test]
async fn plugin_local_failure_keeps_the_sibling_and_process_alive() {
    let fixture = HostFixture::new(
        "plugin-local",
        json!({
            "loads": 2,
            "invoke_modes": {"plugin-00": "guest_error", "plugin-01": "success"}
        }),
    );
    let service = MockService::new("plugin-local", chain_profile(2, PluginRuntimeState::Active));
    let plugins = service.lock().profile.plugins.clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(70)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let pid = pids.lock().unwrap()[0];
    let outcome = supervisor
        .invoke(dispatch(&plugins[0], 300))
        .await
        .unwrap()
        .outcome()
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        InvocationOutcome::Failed(InvocationFailure::GuestTrap)
    ));
    service.wait_failure().await;
    service.wait_completion().await;
    let snapshot = supervisor.snapshot().await.unwrap();
    assert_eq!(snapshot.graph_size, 2);
    assert_eq!(
        snapshot.admitting_plugins,
        vec![plugins[1].plugin_id.clone()]
    );
    assert!(!process_is_absent(pid));
    let sibling = supervisor
        .invoke(dispatch(&plugins[1], 301))
        .await
        .unwrap()
        .outcome()
        .await
        .unwrap();
    assert!(matches!(sibling, InvocationOutcome::Completed(_)));
    assert!(service.lock().fence_requests.is_empty());
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pid));
}

#[cfg(unix)]
#[tokio::test]
async fn sqlite_local_failure_terminalizes_before_health_and_later_fences_only_active_graph() {
    let profile_dir = unique_root("sqlite-local-failure");
    let owner = ProfileOwner::open(&profile_dir).unwrap();
    seed_sqlite_active_plugins(&profile_dir, 2);
    let runtime = SqliteRuntimeService::new(
        sqlite_app_service(&owner),
        profile_dir.join("runtime-sources"),
    );
    let initial = runtime
        .service
        .get_installed_plugin_profile()
        .await
        .unwrap();
    let failing = initial
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id.as_str() == "plugin-00")
        .unwrap()
        .clone();
    let sibling = initial
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id.as_str() == "plugin-01")
        .unwrap()
        .clone();
    let fixture = HostFixture::new(
        "sqlite-local-failure",
        json!({
            "loads": 2,
            "invoke_modes": {"plugin-00": "guest_error", "plugin-01": "hold"}
        }),
    );
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        runtime.clone(),
        fixture.policy(vec![session(74)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();

    let handle = supervisor.invoke(dispatch(&failing, 340)).await.unwrap();
    SqliteRuntimeService::wait(&runtime.completion_started, "completion start").await;
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            runtime.failure_started.acquire()
        )
        .await
        .is_err(),
        "health transition started before terminal durability completed"
    );
    runtime.completion_gate.add_permits(1);
    assert!(matches!(
        handle.outcome().await.unwrap(),
        InvocationOutcome::Failed(InvocationFailure::GuestTrap)
    ));
    SqliteRuntimeService::wait(&runtime.completion_committed, "completion commit").await;
    SqliteRuntimeService::wait(&runtime.failure_committed, "failure commit").await;
    assert_eq!(
        *runtime.durable_order.lock().unwrap(),
        ["complete", "failure"]
    );

    {
        let connection = Connection::open(profile_dir.join("junban.sqlite3")).unwrap();
        let receipt: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1",
                [operation(340).to_string()],
                |row| row.get(0),
            )
            .unwrap();
        let invocation: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM plugin_invocations WHERE operation_id = ?1",
                [operation(340).to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(receipt, 1);
        assert_eq!(invocation, 0);
    }
    let degraded = runtime
        .service
        .get_installed_plugin_profile()
        .await
        .unwrap();
    assert_eq!(
        degraded
            .plugins
            .iter()
            .find(|plugin| plugin.plugin_id == failing.plugin_id)
            .unwrap()
            .runtime_state,
        PluginRuntimeState::Degraded
    );
    assert_eq!(
        degraded
            .plugins
            .iter()
            .find(|plugin| plugin.plugin_id == sibling.plugin_id)
            .unwrap()
            .runtime_state,
        PluginRuntimeState::Active
    );

    let pid = pids.lock().unwrap()[0];
    assert!(
        Command::new("/bin/kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    SqliteRuntimeService::wait(&runtime.fence_committed, "graph fence commit").await;
    assert!(process_is_absent(pid));
    {
        let requests = runtime.fence_requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].entries.len(), 1);
        assert_eq!(requests[0].entries[0].plugin_id, sibling.plugin_id);
        assert_eq!(
            requests[0].entries[0].disposition,
            PluginGraphFenceDisposition::LoadedSibling
        );
    }
    let fenced = runtime
        .service
        .get_installed_plugin_profile()
        .await
        .unwrap();
    let still_degraded = fenced
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id == failing.plugin_id)
        .unwrap();
    let fenced_sibling = fenced
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id == sibling.plugin_id)
        .unwrap();
    assert_eq!(still_degraded.activation_epoch, failing.activation_epoch);
    assert_eq!(still_degraded.runtime_state, PluginRuntimeState::Degraded);
    assert_eq!(
        fenced_sibling.activation_epoch,
        sibling.activation_epoch + 1
    );
    assert_eq!(fenced_sibling.runtime_state, PluginRuntimeState::Degraded);

    drop(supervisor);
    drop(runtime);
    drop(owner);
    fs::remove_dir_all(profile_dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn callbacks_are_staged_and_default_denied_without_slice_two_d_authority() {
    let fixture = HostFixture::new("callback", json!({"loads": 1, "invoke": "callback"}));
    let service = MockService::new("callback", chain_profile(1, PluginRuntimeState::Active));
    let plugin = service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(75)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    assert!(matches!(
        supervisor
            .invoke(dispatch(&plugin, 350))
            .await
            .unwrap()
            .outcome()
            .await
            .unwrap(),
        InvocationOutcome::Completed(_)
    ));
    service.wait_completion().await;
    assert!(fixture.captured_frames().iter().any(|capture| {
        capture["frame"]["type"] == "capability_reply" && capture["frame"]["kind"] == "monotonic_ms"
    }));
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));

    let fixture = HostFixture::new(
        "callback-fence",
        json!({"loads": 1, "invoke": "callback_wrong_id"}),
    );
    let service = MockService::new(
        "callback-fence",
        chain_profile(1, PluginRuntimeState::Active),
    );
    service.require_reap_before_fence(fixture.pid_file.clone());
    let plugin = service.lock().profile.plugins[0].clone();
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(76)], Arc::new(Mutex::new(Vec::new()))),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    assert!(matches!(
        supervisor
            .invoke(dispatch(&plugin, 351))
            .await
            .unwrap()
            .outcome()
            .await
            .unwrap(),
        InvocationOutcome::Failed(InvocationFailure::SessionLost)
    ));
    service.wait_fence().await;
    assert_eq!(service.lock().fence_saw_reaped, [true]);
}

#[cfg(unix)]
#[tokio::test]
async fn authorized_nested_service_uses_parent_authority_without_durable_reservation() {
    let mut target = installed_plugin(
        "service-target",
        1,
        5,
        PluginRuntimeState::Active,
        Vec::new(),
    );
    target.manifest.services = vec![ServiceDeclaration {
        id: "service".to_owned(),
        title: "Service".to_owned(),
        request: Vec::new(),
        response: Vec::new(),
    }];
    let mut caller = installed_plugin(
        "service-caller",
        2,
        5,
        PluginRuntimeState::Active,
        vec![Dependency {
            id: "service-target".to_owned(),
            requirement: "^1.0.0".to_owned(),
            services: vec!["service".to_owned()],
        }],
    );
    caller
        .granted_capabilities
        .push(Capability::ServicesConsume);
    caller.manifest.permissions.push(Permission {
        capability: Capability::ServicesConsume,
        scope: PermissionScope::Services(ServiceConsumeScope {
            services: vec![ServiceReference {
                plugin_id: "service-target".to_owned(),
                service_id: "service".to_owned(),
            }],
        }),
    });
    let service = MockService::new(
        "nested-service",
        profile(
            vec![caller.clone(), target],
            vec!["service-target", "service-caller"],
        ),
    );
    let fixture = HostFixture::new(
        "nested-service",
        json!({
            "loads": 2,
            "invoke_modes": {
                "service-caller": "service_callback",
                "service-target": "success"
            }
        }),
    );
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(77)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    assert!(matches!(
        supervisor
            .invoke(dispatch(&caller, 352))
            .await
            .unwrap()
            .outcome()
            .await
            .unwrap(),
        InvocationOutcome::Completed(_)
    ));
    service.wait_completion().await;
    {
        let state = service.lock();
        assert_eq!(state.counts.reservations, 1);
        assert_eq!(state.counts.completions, 1);
    }
    let nested_invokes: Vec<_> = fixture
        .captured_frames()
        .into_iter()
        .filter(|capture| capture["frame"]["type"] == "invoke")
        .collect();
    assert_eq!(nested_invokes.len(), 2);
    assert_eq!(nested_invokes[1]["frame"]["kind"], "call_service");
    assert_eq!(
        nested_invokes[1]["frame"]["fence"]["plugin_id"],
        "service-target"
    );
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[test]
fn handle_drop_sets_atomic_cancellation_when_actor_queue_is_full() {
    let (sender, _receiver) = mpsc::channel(1);
    let (snapshot, _snapshot_receiver) = oneshot::channel();
    sender
        .try_send(ActorCommand::Snapshot { reply: snapshot })
        .expect("fill actor queue");
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let (_terminal, terminal) = oneshot::channel();
    let handle = PluginInvocationHandle {
        invocation_id: operation(398),
        terminal: Some(terminal),
        cancel_requested: Arc::clone(&cancel_requested),
        commands: sender.downgrade(),
        completed: false,
    };
    drop(handle);
    assert!(cancel_requested.load(Ordering::Acquire));
}

#[cfg(unix)]
#[tokio::test]
async fn cancelled_reservations_hold_all_permits_until_durable_cleanup() {
    let fixture = HostFixture::new(
        "cancel-saturation",
        json!({"loads": 5, "invoke": "hold", "cancel": "cancelled"}),
    );
    let service = MockService::new(
        "cancel-saturation",
        chain_profile(5, PluginRuntimeState::Active),
    );
    let gate = Arc::new(Semaphore::new(0));
    service.set_reserve_gate(Arc::clone(&gate));
    let plugins = service.lock().profile.plugins.clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(78)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();

    for (index, plugin) in plugins.iter().take(ACTIVE_INVOCATIONS_MAX).enumerate() {
        let handle = supervisor
            .invoke(dispatch(plugin, 380 + u64::try_from(index).unwrap()))
            .await
            .unwrap();
        service.wait_reservation().await;
        handle.cancel();
        assert!(matches!(
            handle.outcome().await.unwrap(),
            InvocationOutcome::Cancelled
        ));
        if index == 0 {
            assert!(matches!(
                supervisor.invoke(dispatch(plugin, 390)).await,
                Err(PluginRuntimeError::PluginBusy)
            ));
        }
    }
    assert_eq!(
        wait_active_invocations(&supervisor, ACTIVE_INVOCATIONS_MAX)
            .await
            .active_invocations,
        ACTIVE_INVOCATIONS_MAX
    );
    assert!(matches!(
        supervisor.invoke(dispatch(&plugins[4], 395)).await,
        Err(PluginRuntimeError::InvocationLimit)
    ));
    assert_eq!(service.lock().counts.reservations, ACTIVE_INVOCATIONS_MAX);

    gate.add_permits(ACTIVE_INVOCATIONS_MAX);
    for _ in 0..ACTIVE_INVOCATIONS_MAX {
        service.wait_completion().await;
    }
    wait_active_invocations(&supervisor, 0).await;

    let released = supervisor.invoke(dispatch(&plugins[4], 396)).await.unwrap();
    service.wait_reservation().await;
    released.cancel();
    assert!(matches!(
        released.outcome().await.unwrap(),
        InvocationOutcome::Cancelled
    ));
    gate.add_permits(1);
    service.wait_completion().await;
    wait_active_invocations(&supervisor, 0).await;
    assert_eq!(
        service.lock().counts.reservations,
        ACTIVE_INVOCATIONS_MAX + 1
    );
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_before_reservation_never_reaches_the_child() {
    let fixture = HostFixture::new("cancel-reserving", json!({"loads": 1, "invoke": "hold"}));
    let service = MockService::new(
        "cancel-reserving",
        chain_profile(1, PluginRuntimeState::Active),
    );
    let gate = Arc::new(Semaphore::new(0));
    service.set_reserve_gate(Arc::clone(&gate));
    let plugin = service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(79)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let handle = supervisor.invoke(dispatch(&plugin, 399)).await.unwrap();
    handle.cancel();
    assert!(matches!(
        handle.outcome().await.unwrap(),
        InvocationOutcome::Cancelled
    ));
    gate.add_permits(1);
    service.wait_completion().await;
    assert!(
        fixture
            .captured_frames()
            .iter()
            .all(|capture| { capture["frame"]["type"] != "invoke" })
    );
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn cancellation_drop_and_late_outcome_publish_once_and_hold_one_permit() {
    let fixture = HostFixture::new(
        "cancel-late",
        json!({"loads": 1, "invoke": "hold", "cancel": "late_outcome"}),
    );
    let service = MockService::new("cancel-late", chain_profile(1, PluginRuntimeState::Active));
    let plugin = service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(80)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let handle = supervisor.invoke(dispatch(&plugin, 400)).await.unwrap();
    handle.cancel();
    let terminal = handle.outcome().await.unwrap();
    assert!(matches!(terminal, InvocationOutcome::Cancelled));
    service.wait_completion().await;
    assert_eq!(
        wait_active_invocations(&supervisor, 0)
            .await
            .active_invocations,
        0
    );
    assert_eq!(service.lock().counts.completions, 1);
    assert!(service.lock().fence_requests.is_empty());

    let dropped = supervisor.invoke(dispatch(&plugin, 401)).await.unwrap();
    drop(dropped);
    service.wait_completion().await;
    assert_eq!(
        wait_active_invocations(&supervisor, 0)
            .await
            .active_invocations,
        0
    );
    assert_eq!(service.lock().counts.completions, 2);
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn watchdog_timeout_has_one_terminal_one_receipt_and_no_orphan() {
    let fixture = HostFixture::new(
        "watchdog",
        json!({"loads": 1, "invoke": "hold", "cancel": "late_outcome"}),
    );
    let service = MockService::new("watchdog", chain_profile(1, PluginRuntimeState::Active));
    let plugin = service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(90)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    supervisor.reconcile().await.unwrap();
    let terminal = tokio::time::timeout(
        Duration::from_secs(2),
        supervisor
            .invoke(dispatch(&plugin, 500))
            .await
            .unwrap()
            .outcome(),
    )
    .await
    .expect("watchdog terminal")
    .unwrap();
    assert!(matches!(
        terminal,
        InvocationOutcome::Failed(InvocationFailure::Timeout)
    ));
    service.wait_failure().await;
    service.wait_completion().await;
    assert_eq!(
        wait_active_invocations(&supervisor, 0)
            .await
            .active_invocations,
        0
    );
    assert_eq!(service.lock().counts.failures, 1);
    assert_eq!(service.lock().counts.completions, 1);
    assert!(service.lock().fence_requests.is_empty());
    supervisor.shutdown().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn valid_staged_body_completes_but_every_fence_mismatch_fences_after_reap() {
    let valid_fixture = HostFixture::new("valid-body", json!({"loads": 1, "invoke": "success"}));
    let valid_service =
        MockService::new("valid-body", chain_profile(1, PluginRuntimeState::Active));
    let plugin = valid_service.lock().profile.plugins[0].clone();
    let pids = Arc::new(Mutex::new(Vec::new()));
    let valid = PluginRuntimeSupervisor::for_test(
        valid_service.clone(),
        valid_fixture.policy(vec![session(100)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    valid.reconcile().await.unwrap();
    assert!(matches!(
        valid
            .invoke(dispatch(&plugin, 600))
            .await
            .unwrap()
            .outcome()
            .await
            .unwrap(),
        InvocationOutcome::Completed(_)
    ));
    valid_service.wait_completion().await;
    valid.shutdown().await.unwrap();

    for (index, mode) in [
        "wrong_plugin",
        "wrong_generation",
        "wrong_epoch",
        "wrong_session",
        "wrong_invocation",
        "wrong_kind",
        "malformed_body",
        "partial_body",
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = HostFixture::new(
            &format!("fence-{mode}"),
            json!({"loads": 1, "invoke": mode}),
        );
        let service = MockService::new(
            &format!("fence-{mode}"),
            chain_profile(1, PluginRuntimeState::Active),
        );
        service.require_reap_before_fence(fixture.pid_file.clone());
        let plugin = service.lock().profile.plugins[0].clone();
        let pids = Arc::new(Mutex::new(Vec::new()));
        let supervisor = PluginRuntimeSupervisor::for_test(
            service.clone(),
            fixture.policy(
                vec![session(110 + u64::try_from(index).unwrap())],
                Arc::clone(&pids),
            ),
            Arc::new(DenyCallbacks),
        );
        supervisor.reconcile().await.unwrap();
        let terminal = supervisor
            .invoke(dispatch(&plugin, 700 + u64::try_from(index).unwrap()))
            .await
            .unwrap()
            .outcome()
            .await
            .unwrap();
        assert!(
            matches!(
                terminal,
                InvocationOutcome::Failed(InvocationFailure::SessionLost)
            ) || mode == "partial_body"
                && matches!(
                    terminal,
                    InvocationOutcome::Failed(InvocationFailure::Timeout)
                ),
            "{mode}: {terminal:?}"
        );
        if mode == "partial_body" {
            // The watchdog durably degrades the only plugin before the child
            // misses its cancellation deadline, leaving no Starting/Active
            // authority for the later triggerless loss to fence.
            wait_pids_reaped(&fixture.pid_file).await;
            assert!(service.lock().fence_requests.is_empty());
        } else {
            service.wait_fence().await;
            let state = service.lock();
            assert_eq!(state.fence_requests.len(), 1, "{mode}");
            assert_eq!(state.fence_saw_reaped, [true], "{mode}");
            drop(state);
        }
        assert!(
            read_pids(&fixture.pid_file)
                .iter()
                .all(|pid| process_is_absent(*pid))
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn attributed_load_failure_reaps_reconciles_and_fences_the_mixed_graph_once() {
    let base = installed_plugin("z-base", 1, 4, PluginRuntimeState::Starting, Vec::new());
    let dependent = installed_plugin(
        "a-dependent",
        2,
        4,
        PluginRuntimeState::Starting,
        vec![Dependency {
            id: "z-base".to_owned(),
            requirement: "^1.0.0".to_owned(),
            services: Vec::new(),
        }],
    );
    let sibling = installed_plugin("m-sibling", 3, 4, PluginRuntimeState::Starting, Vec::new());
    let service = MockService::new(
        "load-failure",
        profile(
            vec![dependent, sibling, base],
            vec!["z-base", "a-dependent", "m-sibling"],
        ),
    );
    let fixture = HostFixture::new(
        "load-failure",
        json!({"loads": 3, "load_failure": "z-base"}),
    );
    service.require_reap_before_fence(fixture.pid_file.clone());
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(129)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    assert_eq!(
        supervisor.reconcile().await,
        Err(PluginRuntimeError::SessionLost)
    );
    service.wait_fence().await;
    let state = service.lock();
    assert_eq!(state.counts.reconcile_packages, 1);
    assert_eq!(state.fence_requests.len(), 1);
    assert_eq!(state.fence_saw_reaped, [true]);
    let entries = &state.fence_requests[0].entries;
    assert!(entries.iter().any(|entry| {
        entry.plugin_id.as_str() == "z-base"
            && entry.disposition == PluginGraphFenceDisposition::Failing
            && entry.cause == PluginGraphFenceCause::CompileLoad
    }));
    assert!(entries.iter().any(|entry| {
        entry.plugin_id.as_str() == "a-dependent"
            && entry.disposition == PluginGraphFenceDisposition::SkippedDependent
    }));
    assert!(entries.iter().any(|entry| {
        entry.plugin_id.as_str() == "m-sibling"
            && entry.disposition == PluginGraphFenceDisposition::LoadedSibling
    }));
    drop(state);
    assert!(process_is_absent(pids.lock().unwrap()[0]));
}

#[cfg(unix)]
#[tokio::test]
async fn triggerless_runtime_loss_fences_mixed_graph_once_and_cas_failure_stays_fenced() {
    let fixture = HostFixture::new(
        "triggerless",
        json!({"loads": 3, "runtime_fault": "idle_exit"}),
    );
    let mut graph = chain_profile(3, PluginRuntimeState::Active);
    graph.plugins[0].runtime_state = PluginRuntimeState::Starting;
    let service = MockService::new("triggerless", graph);
    service.require_reap_before_fence(fixture.pid_file.clone());
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(130)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    let _ = supervisor.reconcile().await;
    service.wait_fence().await;
    {
        let state = service.lock();
        assert_eq!(state.fence_requests.len(), 1);
        let request = &state.fence_requests[0];
        assert_eq!(request.host_session_id, session(130).to_string());
        assert_eq!(request.entries.len(), 3);
        assert!(request.entries.iter().all(|entry| {
            entry.disposition == PluginGraphFenceDisposition::LoadedSibling
                && entry.cause == PluginGraphFenceCause::SessionLost
        }));
        assert_eq!(state.fence_saw_reaped, [true]);
    }

    let fixture = HostFixture::new(
        "fence-cas",
        json!({"loads": 1, "runtime_fault": "idle_exit"}),
    );
    let service = MockService::new("fence-cas", chain_profile(1, PluginRuntimeState::Active));
    service.lock().fail_fence = true;
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(131)], Arc::new(Mutex::new(Vec::new()))),
        Arc::new(DenyCallbacks),
    );
    let _ = supervisor.reconcile().await;
    service.wait_fence().await;
    assert_eq!(
        supervisor.snapshot().await.unwrap().lifecycle,
        PluginRuntimeLifecycle::Fenced
    );
}

#[cfg(unix)]
#[tokio::test]
async fn connect_hello_and_runtime_faults_are_triggerless_and_leave_no_orphan() {
    for (index, config) in [
        json!({"loads": 1, "hello": "malformed"}),
        json!({"loads": 1, "hello": "partial"}),
        json!({"loads": 1, "hello": "stalled"}),
        json!({"loads": 1, "hello": "wrong_product"}),
        json!({"loads": 1, "runtime_fault": "malformed"}),
        json!({"loads": 1, "runtime_fault": "partial"}),
        json!({"loads": 1, "runtime_fault": "stalled"}),
    ]
    .into_iter()
    .enumerate()
    {
        let fixture = HostFixture::new(&format!("fault-{index}"), config);
        let service = MockService::new(
            &format!("fault-{index}"),
            chain_profile(1, PluginRuntimeState::Starting),
        );
        service.require_reap_before_fence(fixture.pid_file.clone());
        let supervisor = PluginRuntimeSupervisor::for_test(
            service.clone(),
            fixture.policy(
                vec![session(150 + u64::try_from(index).unwrap())],
                Arc::new(Mutex::new(Vec::new())),
            ),
            Arc::new(DenyCallbacks),
        );
        let result = supervisor.reconcile().await;
        if result.is_ok() {
            assert_eq!(supervisor.shutdown().await, Err(PluginRuntimeError::Closed));
        }
        service.wait_fence().await;
        let state = service.lock();
        assert_eq!(state.fence_requests.len(), 1, "fault {index}");
        assert!(state.fence_requests[0].entries.iter().all(|entry| {
            entry.disposition == PluginGraphFenceDisposition::LoadedSibling
                && entry.cause == PluginGraphFenceCause::SessionLost
        }));
        assert_eq!(state.fence_saw_reaped, [true]);
        drop(state);
        assert!(
            read_pids(&fixture.pid_file)
                .iter()
                .all(|pid| process_is_absent(*pid))
        );
    }

    let missing = unique_root("missing-host").join("missing");
    let service = MockService::new(
        "missing-host",
        chain_profile(1, PluginRuntimeState::Starting),
    );
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        PluginHostLaunchPolicy::explicit(
            missing,
            test_deadlines(),
            vec![session(170)],
            Arc::new(Mutex::new(Vec::new())),
        ),
        Arc::new(DenyCallbacks),
    );
    assert_eq!(
        supervisor.reconcile().await,
        Err(PluginRuntimeError::SessionLost)
    );
    service.wait_fence().await;
    let state = service.lock();
    assert_eq!(
        state.fence_requests[0].host_session_id,
        session(170).to_string()
    );
    assert_eq!(state.fence_requests[0].entries.len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn graceful_and_forced_shutdown_reap_without_detached_processes() {
    for (index, shutdown) in ["graceful", "forced"].into_iter().enumerate() {
        let fixture = HostFixture::new(
            &format!("shutdown-{shutdown}"),
            json!({"loads": 1, "shutdown": shutdown}),
        );
        let service = MockService::new(
            &format!("shutdown-{shutdown}"),
            chain_profile(1, PluginRuntimeState::Active),
        );
        if shutdown == "forced" {
            service.require_reap_before_fence(fixture.pid_file.clone());
        }
        let pids = Arc::new(Mutex::new(Vec::new()));
        let supervisor = PluginRuntimeSupervisor::for_test(
            service.clone(),
            fixture.policy(
                vec![session(180 + u64::try_from(index).unwrap())],
                Arc::clone(&pids),
            ),
            Arc::new(DenyCallbacks),
        );
        supervisor.reconcile().await.unwrap();
        let result = supervisor.shutdown().await;
        if shutdown == "graceful" {
            assert_eq!(result, Ok(()));
            assert!(service.lock().fence_requests.is_empty());
        } else {
            assert!(matches!(result, Err(PluginRuntimeError::Closed)));
            service.wait_fence().await;
            assert_eq!(service.lock().fence_saw_reaped, [true]);
        }
        assert!(process_is_absent(pids.lock().unwrap()[0]));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn due_retry_startup_and_restore_paths_preserve_dormancy_rules() {
    let mut due = chain_profile(1, PluginRuntimeState::Degraded);
    due.plugins[0].failure_count = 2;
    due.plugins[0].next_retry_at = Some(timestamp("2026-01-01T00:00:00Z"));
    let fixture = HostFixture::new("due-retry", json!({"loads": 1}));
    let service = MockService::new("due-retry", due);
    let pids = Arc::new(Mutex::new(Vec::new()));
    let supervisor = PluginRuntimeSupervisor::for_test(
        service.clone(),
        fixture.policy(vec![session(190)], Arc::clone(&pids)),
        Arc::new(DenyCallbacks),
    );
    let snapshot = supervisor.reconcile().await.unwrap();
    assert_eq!(snapshot.admitting_plugins.len(), 1);
    {
        let state = service.lock();
        assert_eq!(state.counts.due_retries, 1);
        assert_eq!(state.due_requests[0].activation_epoch, 10);
        assert_eq!(state.profile.plugins[0].activation_epoch, 11);
        assert_eq!(state.profile.plugins[0].failure_count, 2);
        assert_eq!(
            state.profile.plugins[0].runtime_state,
            PluginRuntimeState::Active
        );
    }
    supervisor.restore_dormant().await.unwrap();
    assert!(process_is_absent(pids.lock().unwrap()[0]));
    assert_eq!(
        supervisor.snapshot().await.unwrap(),
        PluginRuntimeSnapshot::dormant()
    );
    let state = service.lock();
    assert_eq!(state.counts.open_sources, 1);
    assert!(state.fence_requests.is_empty());
}

#[test]
fn slice_two_c_does_not_commit_deferred_effects_or_expose_http_authority() {
    let deferred = GuestInvocationOutcome::InvokeCommand(WitResult::Ok(PluginOutcome {
        effect: Some(
            junban_plugin_sdk::private_body_types::PluginEffect::KvPatch(
                junban_plugin_sdk::private_body_types::KvPatch {
                    operations: Vec::new(),
                },
            ),
        ),
    }));
    assert!(outcome_has_deferred_effect(&deferred));
    assert!(matches!(
        denied_host_reply(HostCallKind::HttpRequest),
        HostCallReply::HttpRequest(WitResult::Err(_))
    ));
}
