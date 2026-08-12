//! Non-shipped Phase 7 Slice 2E production-composition and resource harness.
//!
//! The Python runner opts these ordinary (non-ignored) tests into real release-host
//! execution with absolute fixture paths. Ordinary workspace tests retain the
//! supervisor's dormant contract and do not build or discover a host binary.

use std::{
    collections::BTreeSet,
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use ed25519_dalek::SigningKey;
use junban_app::{
    PluginInstallSource, PluginRuntimeState, ReplacePluginGrantsRequest, SetPluginSettingRequest,
    StagedFile, TrustPublisherRequest,
};
use junban_domain::{OperationId, TaskDraft, TaskTitle};
use junban_plugin_sdk::{
    AuthorityFence, Capability, CommandDeclaration, DataKind, Dependency, EventKind, EventScope,
    HttpMethod, HttpOrigin, HttpScope, InputField, InvocationRequest, Permission, PermissionScope,
    Publisher, RuntimeManifest, RuntimeProfile, ServiceConsumeScope, ServiceDeclaration,
    ServiceField, ServiceReference, SettingDeclaration, SettingSchema, SettingValue, Sha256Digest,
    UnscopedPermission, WitAuthority, canonical_permission_hash, inspect_component_for_runtime,
    pack_package,
    private_body_types::{self as wit, CommandCall, DataValue, NamedValue, ScalarValue, WitResult},
    signer_key_id,
};
use junban_storage::ProfileOwner;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, oneshot},
};
use uuid::Uuid;

use super::*;
use crate::{
    BroadcastEventSink,
    plugin_callbacks::{
        PluginCallbackError, PluginCallbackFuture, PluginCallbackHttp, PluginCallbackPort,
        PluginLiveAuthority,
    },
    plugin_host_process::ProcessDeadlines,
    reminder_wake::ReminderWakeHub,
    sse::AppService,
};

const ENABLE_ENV: &str = "JUNBAN_SLICE2E_RUN";
const HOST_ENV: &str = "JUNBAN_SLICE2E_HOST";
const RUST_ENV: &str = "JUNBAN_SLICE2E_RUST_COMPONENT";
const TYPESCRIPT_ENV: &str = "JUNBAN_SLICE2E_TYPESCRIPT_COMPONENT";
const TYPESCRIPT_STANDALONE_ENV: &str = "JUNBAN_SLICE2E_TYPESCRIPT_STANDALONE_COMPONENT";
const CONFORMANCE_ENV: &str = "JUNBAN_SLICE2E_CONFORMANCE_COMPONENT";
const TEST_WAIT: Duration = Duration::from_secs(30);
const SIGNING_KEY_BYTES: [u8; 32] = [0x2e; 32];
const ROOT_SERVICE_ID: &str = "state";

const CASE_INVENTORY: &[&str] = &[
    "typed-package-admission",
    "rust-import-load-activate-invoke-deactivate",
    "typescript-import-load-activate-invoke-deactivate",
    "ordinary-query-settings-kv",
    "returned-kv-patch",
    "returned-domain-effect",
    "loopback-http-consume-once-delivery-id",
    "resync-catch-up-cursor-commit",
    "failed-event-no-cursor-or-effect",
    "nested-service-call",
    "cancel-before-dispatch",
    "cancel-blocked-callback-store-replacement",
    "guest-trap",
    "wasm-timeout",
    "output-bound",
    "callback-resource-failure",
    "wasm-resource-failure",
    "one-four-sixteen-graph",
    "fifth-and-same-plugin-admission",
    "sibling-isolation",
    "real-child-kill-eof-reap",
    "post-fault-retry-fresh-store",
    "all-children-reaped",
];

#[derive(Clone)]
struct FixturePaths {
    host: PathBuf,
    rust: PathBuf,
    typescript: PathBuf,
    typescript_standalone: PathBuf,
    conformance: PathBuf,
}

impl FixturePaths {
    fn from_environment() -> Option<Self> {
        if env::var(ENABLE_ENV).ok().as_deref() != Some("1") {
            return None;
        }
        Some(Self {
            host: required_absolute_file(HOST_ENV),
            rust: required_absolute_file(RUST_ENV),
            typescript: required_absolute_file(TYPESCRIPT_ENV),
            typescript_standalone: required_absolute_file(TYPESCRIPT_STANDALONE_ENV),
            conformance: required_absolute_file(CONFORMANCE_ENV),
        })
    }
}

fn required_absolute_file(name: &str) -> PathBuf {
    let path = PathBuf::from(env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    assert!(path.is_absolute(), "{name} must be absolute");
    let metadata = fs::symlink_metadata(&path).unwrap_or_else(|_| panic!("{name} is unreadable"));
    assert!(
        metadata.file_type().is_file(),
        "{name} must be a regular file"
    );
    assert!(
        !metadata.file_type().is_symlink(),
        "{name} cannot be a link"
    );
    path
}

struct ProfileGuard(PathBuf);

impl ProfileGuard {
    fn new(label: &str) -> Self {
        let root = env::temp_dir().join(format!("junban-slice2e-{label}-{}", Uuid::now_v7()));
        fs::create_dir(&root).expect("create Slice 2E profile");
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ProfileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn app_service(owner: &ProfileOwner) -> AppService {
    let sink = BroadcastEventSink::new(32, Arc::new(ReminderWakeHub::new()));
    junban_app::TaskService::new(Arc::new(owner.repository()), Arc::new(sink))
}

fn stage_bytes(root: &Path, bytes: &[u8]) -> StagedFile {
    let path = root.join(format!("stage-{}.jbp", Uuid::now_v7()));
    fs::write(&path, bytes).expect("stage package");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("private staged package");
    }
    StagedFile::new(path, bytes.len() as u64)
}

fn unscoped(capability: Capability) -> Permission {
    Permission {
        capability,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    }
}

fn sorted_permissions(mut permissions: Vec<Permission>) -> Vec<Permission> {
    permissions.sort_by_key(|permission| permission.capability.as_str());
    permissions
}

fn command(id: &str, inputs: Vec<InputField>) -> CommandDeclaration {
    CommandDeclaration {
        id: id.to_owned(),
        title: id.to_owned(),
        description: "Phase 7 Slice 2E conformance command".to_owned(),
        icon: None,
        inputs,
    }
}

fn input(id: &str, kind: DataKind) -> InputField {
    InputField {
        id: id.to_owned(),
        label: id.to_owned(),
        description: "Slice 2E command authority".to_owned(),
        kind,
        required: true,
    }
}

fn state_service() -> ServiceDeclaration {
    ServiceDeclaration {
        id: ROOT_SERVICE_ID.to_owned(),
        title: "State".to_owned(),
        request: Vec::new(),
        response: vec![ServiceField {
            id: "activation-count".to_owned(),
            kind: DataKind::Integer,
            required: true,
        }],
    }
}

fn publisher(key: &SigningKey) -> Publisher {
    Publisher {
        id: "slice2e-publisher".to_owned(),
        name: "Slice 2E Harness".to_owned(),
        key_id: signer_key_id(&key.verifying_key().to_bytes()).to_string(),
    }
}

fn manifest_base(
    id: &str,
    profile: RuntimeProfile,
    component: &[u8],
    key: &SigningKey,
) -> RuntimeManifest {
    RuntimeManifest {
        schema_version: 1,
        id: id.to_owned(),
        name: format!("Slice 2E {id}"),
        description: "Non-shipped production-composition fixture".to_owned(),
        version: "1.0.0".to_owned(),
        publisher: publisher(key),
        license: "MIT".to_owned(),
        junban_compatibility: "^0.1".to_owned(),
        wit: WitAuthority {
            package: "junban:plugin".to_owned(),
            world: "plugin".to_owned(),
            version: "0.1.0".to_owned(),
        },
        runtime_profile: profile,
        component_sha256: Sha256Digest::of(component).to_string(),
        permissions: Vec::new(),
        dependencies: Vec::new(),
        commands: Vec::new(),
        subscriptions: Vec::new(),
        surfaces: Vec::new(),
        settings: Vec::new(),
        services: Vec::new(),
    }
}

fn root_manifest(id: &str, component: &[u8], key: &SigningKey) -> RuntimeManifest {
    let mut manifest = manifest_base(id, RuntimeProfile::Rust, component, key);
    manifest.permissions = sorted_permissions(vec![
        unscoped(Capability::Commands),
        unscoped(Capability::Logging),
        unscoped(Capability::ServicesProvide),
        unscoped(Capability::Settings),
        unscoped(Capability::Storage),
        unscoped(Capability::TasksRead),
    ]);
    manifest.commands = [
        "memory-calibration-barrier",
        "memory-grow",
        "normal",
        "oversized-output",
        "spin",
        "trap",
    ]
    .into_iter()
    .map(|id| command(id, Vec::new()))
    .collect();
    manifest.services = vec![state_service()];
    manifest
}

fn dependency(root_id: &str) -> Dependency {
    Dependency {
        id: root_id.to_owned(),
        requirement: "^1.0.0".to_owned(),
        services: vec![ROOT_SERVICE_ID.to_owned()],
    }
}

fn consume_permission(root_id: &str) -> Permission {
    Permission {
        capability: Capability::ServicesConsume,
        scope: PermissionScope::Services(ServiceConsumeScope {
            services: vec![ServiceReference {
                plugin_id: root_id.to_owned(),
                service_id: ROOT_SERVICE_ID.to_owned(),
            }],
        }),
    }
}

fn conformance_manifest(
    id: &str,
    root_id: &str,
    origin: &str,
    component: &[u8],
    key: &SigningKey,
) -> RuntimeManifest {
    let mut manifest = manifest_base(id, RuntimeProfile::Rust, component, key);
    manifest.permissions = sorted_permissions(vec![
        unscoped(Capability::Commands),
        Permission {
            capability: Capability::EventsSubscribe,
            scope: PermissionScope::Events(EventScope {
                event_kinds: vec![EventKind::TaskCreated],
            }),
        },
        Permission {
            capability: Capability::Http,
            scope: PermissionScope::Http(HttpScope {
                origins: vec![HttpOrigin(origin.to_owned())],
                methods: vec![HttpMethod::Post],
            }),
        },
        consume_permission(root_id),
        unscoped(Capability::ServicesProvide),
        unscoped(Capability::Settings),
        unscoped(Capability::Storage),
        unscoped(Capability::TasksRead),
        unscoped(Capability::TasksWrite),
    ]);
    manifest.dependencies = vec![dependency(root_id)];
    manifest.commands = vec![
        command("block", Vec::new()),
        command("callback-error", Vec::new()),
        command("domain-effect", Vec::new()),
        command("http", vec![input("origin", DataKind::String)]),
        command("kv-effect", Vec::new()),
        command("memory-grow", Vec::new()),
        command("nested", vec![input("target", DataKind::PluginId)]),
        command("ordinary", Vec::new()),
        command("oversized-output", Vec::new()),
        command("ping", Vec::new()),
        command("state", Vec::new()),
        command("trap", Vec::new()),
    ];
    manifest.subscriptions = vec![EventKind::TaskCreated];
    manifest.settings = vec![SettingDeclaration {
        id: "mode".to_owned(),
        label: "Mode".to_owned(),
        description: "Conformance mode".to_owned(),
        schema: SettingSchema::Text {
            default: "default".to_owned(),
            min_bytes: 1,
            max_bytes: 32,
            secret: false,
        },
    }];
    manifest.services = vec![state_service()];
    manifest
}

fn typescript_manifest(
    id: &str,
    root_id: &str,
    component: &[u8],
    key: &SigningKey,
) -> RuntimeManifest {
    let mut manifest = manifest_base(id, RuntimeProfile::Typescript, component, key);
    manifest.permissions = sorted_permissions(vec![
        unscoped(Capability::Commands),
        unscoped(Capability::Logging),
        consume_permission(root_id),
        unscoped(Capability::ServicesProvide),
        unscoped(Capability::Settings),
        unscoped(Capability::Storage),
        unscoped(Capability::TasksRead),
    ]);
    manifest.dependencies = vec![dependency(root_id)];
    manifest.commands = vec![
        command("memory-calibration-barrier", Vec::new()),
        command("normal", Vec::new()),
    ];
    manifest.services = vec![state_service()];
    manifest
}

fn typescript_standalone_manifest(id: &str, component: &[u8], key: &SigningKey) -> RuntimeManifest {
    let mut manifest = manifest_base(id, RuntimeProfile::Typescript, component, key);
    manifest.permissions = vec![unscoped(Capability::Commands)];
    manifest.commands = vec![command("normal", Vec::new())];
    manifest
}

async fn initialize_plugin_policy(service: &AppService, key: &SigningKey) {
    service
        .set_community_plugin_policy(OperationId::new(), true, Timestamp::now())
        .await
        .expect("enable local package policy");
    service
        .trust_publisher(
            OperationId::new(),
            TrustPublisherRequest::new(key.verifying_key().to_bytes()),
            Timestamp::now(),
        )
        .await
        .expect("trust fixture publisher");
}

fn expected_imports(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

fn assert_fixture_imports(paths: &FixturePaths) {
    const WASI: &[&str] = &[
        "wasi:cli/environment@0.2.6",
        "wasi:cli/exit@0.2.6",
        "wasi:cli/stderr@0.2.6",
        "wasi:io/error@0.2.6",
        "wasi:io/streams@0.2.6",
    ];
    const RUST: &[&str] = &[
        "junban:plugin/host-log@0.1.0",
        "junban:plugin/host-settings@0.1.0",
        "junban:plugin/host-storage@0.1.0",
        "junban:plugin/host-tasks@0.1.0",
        "junban:plugin/types@0.1.0",
    ];
    const TYPESCRIPT: &[&str] = &[
        "junban:plugin/host-log@0.1.0",
        "junban:plugin/host-services@0.1.0",
        "junban:plugin/host-settings@0.1.0",
        "junban:plugin/host-storage@0.1.0",
        "junban:plugin/host-tasks@0.1.0",
        "junban:plugin/types@0.1.0",
    ];
    const CONFORMANCE: &[&str] = &[
        "junban:plugin/host-http@0.1.0",
        "junban:plugin/host-services@0.1.0",
        "junban:plugin/host-settings@0.1.0",
        "junban:plugin/host-storage@0.1.0",
        "junban:plugin/host-tasks@0.1.0",
        "junban:plugin/types@0.1.0",
    ];

    let key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
    let rust = fs::read(&paths.rust).expect("read Rust fixture for import audit");
    let typescript = fs::read(&paths.typescript).expect("read TypeScript fixture for import audit");
    let typescript_standalone = fs::read(&paths.typescript_standalone)
        .expect("read standalone TypeScript fixture for import audit");
    let conformance =
        fs::read(&paths.conformance).expect("read conformance fixture for import audit");
    let rust_manifest = root_manifest("audit-root", &rust, &key);
    let typescript_manifest =
        typescript_manifest("audit-typescript", "audit-root", &typescript, &key);
    let typescript_standalone_manifest =
        typescript_standalone_manifest("audit-typescript-standalone", &typescript_standalone, &key);
    let conformance_manifest = conformance_manifest(
        "audit-conformance",
        "audit-root",
        "https://slice2e.test:4443",
        &conformance,
        &key,
    );

    let mut expected_rust = expected_imports(RUST);
    expected_rust.extend(expected_imports(WASI));
    let mut expected_conformance = expected_imports(CONFORMANCE);
    expected_conformance.extend(expected_imports(WASI));
    let actual_rust: BTreeSet<_> =
        inspect_component_for_runtime(&rust, RuntimeProfile::Rust, &rust_manifest.permissions)
            .expect("inspect Rust fixture")
            .imports
            .into_iter()
            .collect();
    let actual_typescript: BTreeSet<_> = inspect_component_for_runtime(
        &typescript,
        RuntimeProfile::Typescript,
        &typescript_manifest.permissions,
    )
    .expect("inspect TypeScript fixture")
    .imports
    .into_iter()
    .collect();
    let actual_typescript_standalone: BTreeSet<_> = inspect_component_for_runtime(
        &typescript_standalone,
        RuntimeProfile::Typescript,
        &typescript_standalone_manifest.permissions,
    )
    .expect("inspect standalone TypeScript fixture")
    .imports
    .into_iter()
    .collect();
    let actual_conformance: BTreeSet<_> = inspect_component_for_runtime(
        &conformance,
        RuntimeProfile::Rust,
        &conformance_manifest.permissions,
    )
    .expect("inspect conformance fixture")
    .imports
    .into_iter()
    .collect();
    assert_eq!(actual_rust, expected_rust, "Rust fixture import drift");
    assert_eq!(
        actual_typescript,
        expected_imports(TYPESCRIPT),
        "TypeScript fixture import drift"
    );
    assert_eq!(
        actual_typescript_standalone,
        expected_imports(&["junban:plugin/types@0.1.0"]),
        "standalone TypeScript fixture gained a capability import"
    );
    assert_eq!(
        actual_conformance, expected_conformance,
        "conformance fixture import drift"
    );
}

async fn install_plugin(
    service: &AppService,
    profile_root: &Path,
    manifest: RuntimeManifest,
    component: &[u8],
    key: &SigningKey,
) -> junban_app::InstalledPlugin {
    let package = pack_package(&manifest, component, key).expect("sign fixture package");
    let staged = stage_bytes(profile_root, &package);
    let admission = service
        .inspect_plugin_package(staged)
        .expect("inspect staged package through AppService");
    service
        .install_plugin_admission(
            OperationId::new(),
            admission,
            PluginInstallSource::LocalPackage,
            false,
            false,
            Timestamp::now(),
        )
        .await
        .expect("install staged package through AppService");
    let plugin_id = junban_plugin_sdk::PluginId::parse(manifest.id.clone()).expect("plugin id");
    let installed = service
        .get_installed_plugin(plugin_id.clone())
        .await
        .expect("installed plugin");
    service
        .replace_plugin_grants(
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                plugin_id.clone(),
                installed.package_generation,
                &manifest.permissions,
                manifest.permissions.clone(),
            )
            .expect("typed grants"),
            Timestamp::now(),
        )
        .await
        .expect("grant fixture capabilities");
    if manifest.settings.iter().any(|setting| setting.id == "mode") {
        service
            .set_plugin_setting(
                OperationId::new(),
                SetPluginSettingRequest {
                    plugin_id: plugin_id.clone(),
                    package_generation: installed.package_generation,
                    key: junban_plugin_sdk::PluginId::parse("mode").expect("setting id"),
                    value: SettingValue::Text("conformance".to_owned()),
                },
                Timestamp::now(),
            )
            .await
            .expect("set typed fixture setting");
    }
    service
        .set_plugin_desired_enabled(
            OperationId::new(),
            plugin_id.clone(),
            true,
            Timestamp::now(),
        )
        .await
        .expect("enable fixture plugin");
    service
        .get_installed_plugin(plugin_id)
        .await
        .expect("enabled plugin")
}

fn launch_policy(host: &Path, pids: Arc<Mutex<Vec<u32>>>) -> PluginHostLaunchPolicy {
    let sessions = (1_u128..=128).map(Uuid::from_u128).collect();
    PluginHostLaunchPolicy::explicit(
        host.to_path_buf(),
        ProcessDeadlines {
            // This integration test must observe the host's pinned Wasmtime
            // epoch timeout before the parent process watchdog. Direct-host
            // tests remain authoritative for exact containment thresholds.
            control: TEST_WAIT,
            compile_load: TEST_WAIT,
        },
        sessions,
        pids,
    )
}

fn string_value(name: &str, value: &str) -> NamedValue {
    NamedValue {
        name: name.to_owned(),
        value: DataValue::Scalar(ScalarValue::StringValue(value.to_owned())),
    }
}

fn command_dispatch(
    plugin: &junban_app::InstalledPlugin,
    command_id: &str,
    values: Vec<NamedValue>,
) -> PluginInvocationDispatch {
    let operation_id = OperationId::new();
    let delivery_operation_id = OperationId::new();
    let request = InvocationRequest::invoke_command(
        Some(command_id.to_owned()),
        CommandCall {
            command_id: command_id.to_owned(),
            values,
        },
    );
    let (_, body) = request
        .clone()
        .into_parent_message(
            AuthorityFence {
                plugin_id: plugin.plugin_id.to_string(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: Uuid::from_u128(999).to_string(),
                invocation_id: operation_id.to_string(),
            },
            canonical_permission_hash(&plugin.manifest.permissions).expect("permission hash"),
        )
        .expect("encode command")
        .into_parts();
    PluginInvocationDispatch {
        operation_id,
        plugin_id: plugin.plugin_id.clone(),
        package_generation: plugin.package_generation,
        activation_epoch: plugin.activation_epoch,
        hook_kind: junban_app::PluginHookKind::InvokeCommand,
        entry: junban_app::PluginManifestEntry::Command {
            command_id: junban_plugin_sdk::PluginId::parse(command_id).expect("command id"),
        },
        payload_sha256: Sha256Digest::of(&body),
        delivery_operation_id,
        mode: junban_app::PluginDeliveryMode::Active,
        retained_event_source: None,
        request,
    }
}

async fn terminal(handle: PluginInvocationHandle) -> InvocationOutcome {
    tokio::time::timeout(TEST_WAIT, handle.outcome())
        .await
        .expect("invocation terminal deadline")
        .expect("invocation terminal")
}

async fn invoke_completed(
    supervisor: &PluginRuntimeSupervisor,
    plugin: &junban_app::InstalledPlugin,
    command_id: &str,
    values: Vec<NamedValue>,
) -> GuestInvocationOutcome {
    let outcome = terminal(
        supervisor
            .invoke(command_dispatch(plugin, command_id, values))
            .await
            .expect("command admitted"),
    )
    .await;
    wait_quiescent(supervisor).await;
    match outcome {
        InvocationOutcome::Completed(outcome) => *outcome,
        other => panic!(
            "{command_id} for {} did not complete: {other:?}",
            plugin.plugin_id
        ),
    }
}

async fn wait_quiescent(supervisor: &PluginRuntimeSupervisor) {
    tokio::time::timeout(TEST_WAIT, async {
        loop {
            if supervisor
                .snapshot()
                .await
                .expect("runtime snapshot")
                .active_invocations
                == 0
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("runtime quiescence deadline");
}

fn kv_value(entries: &[junban_app::PluginKvEntry], key: &str) -> Option<Vec<u8>> {
    entries
        .iter()
        .find(|entry| entry.key == key)
        .map(|entry| entry.value.clone())
}

#[derive(Clone)]
struct BarrierCallbacks {
    service: AppService,
    barrier: Arc<AtomicBool>,
    fail_next: Arc<AtomicBool>,
    entered: Arc<Semaphore>,
    release: Arc<Semaphore>,
}

impl BarrierCallbacks {
    fn new(service: AppService) -> Arc<Self> {
        Arc::new(Self {
            service,
            barrier: Arc::new(AtomicBool::new(false)),
            fail_next: Arc::new(AtomicBool::new(false)),
            entered: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
        })
    }

    fn block(&self) {
        while let Ok(permit) = self.entered.try_acquire() {
            permit.forget();
        }
        while let Ok(permit) = self.release.try_acquire() {
            permit.forget();
        }
        self.barrier.store(true, Ordering::Release);
    }

    fn unblock(&self) {
        self.barrier.store(false, Ordering::Release);
        self.release.add_permits(32);
    }

    fn fail_one(&self) {
        self.fail_next.store(true, Ordering::Release);
    }

    async fn wait_entries(&self, count: u32) {
        let permit = tokio::time::timeout(
            TEST_WAIT,
            Arc::clone(&self.entered).acquire_many_owned(count),
        )
        .await
        .expect("callback entry deadline")
        .expect("callback entry semaphore");
        permit.forget();
    }
}

impl PluginCallbackPort for BarrierCallbacks {
    fn authority(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> PluginCallbackFuture<PluginLiveAuthority> {
        PluginCallbackPort::authority(&self.service, plugin_id)
    }

    fn query_tasks(&self, request: wit::TaskQuery) -> PluginCallbackFuture<wit::TaskPage> {
        let service = self.service.clone();
        let barrier = Arc::clone(&self.barrier);
        let fail_next = Arc::clone(&self.fail_next);
        let entered = Arc::clone(&self.entered);
        let release = Arc::clone(&self.release);
        Box::pin(async move {
            if fail_next.swap(false, Ordering::AcqRel) {
                return Err(PluginCallbackError::OperationTooLarge);
            }
            if barrier.load(Ordering::Acquire) {
                entered.add_permits(1);
                let permit = release
                    .acquire_owned()
                    .await
                    .map_err(|_| PluginCallbackError::Unavailable)?;
                permit.forget();
            }
            PluginCallbackPort::query_tasks(&service, request).await
        })
    }

    fn query_projects(&self, request: wit::CatalogQuery) -> PluginCallbackFuture<wit::ProjectPage> {
        PluginCallbackPort::query_projects(&self.service, request)
    }

    fn query_tags(&self, request: wit::CatalogQuery) -> PluginCallbackFuture<wit::TagPage> {
        PluginCallbackPort::query_tags(&self.service, request)
    }

    fn settings(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> PluginCallbackFuture<Vec<junban_app::PluginSetting>> {
        PluginCallbackPort::settings(&self.service, plugin_id)
    }

    fn kv(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> PluginCallbackFuture<Vec<junban_app::PluginKvEntry>> {
        PluginCallbackPort::kv(&self.service, plugin_id)
    }

    fn transition_invocation(
        &self,
        request: junban_app::AuthorizedTransitionPluginInvocationRequest,
    ) -> PluginCallbackFuture<()> {
        PluginCallbackPort::transition_invocation(&self.service, request)
    }
}

#[derive(Clone)]
struct LoopbackHttp {
    address: SocketAddr,
}

impl PluginCallbackHttp for LoopbackHttp {
    fn send(
        &self,
        _grant: HttpScope,
        request: wit::HttpRequest,
        delivery_id: String,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<wit::HttpResponse, wit::HttpError>>
                + Send
                + 'static,
        >,
    > {
        let address = self.address;
        Box::pin(async move {
            let mut stream = TcpStream::connect(address)
                .await
                .map_err(|_| loopback_error())?;
            let body = request.body.into_vec();
            let head = format!(
                "POST {} HTTP/1.1\r\nHost: slice2e.test\r\nx-junban-plugin-delivery-id: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                request.path_and_query,
                delivery_id,
                body.len(),
            );
            stream
                .write_all(head.as_bytes())
                .await
                .map_err(|_| loopback_error())?;
            stream
                .write_all(&body)
                .await
                .map_err(|_| loopback_error())?;
            stream.shutdown().await.map_err(|_| loopback_error())?;
            let mut response = Vec::new();
            stream
                .read_to_end(&mut response)
                .await
                .map_err(|_| loopback_error())?;
            if !response.starts_with(b"HTTP/1.1 200") || !response.ends_with(b"accepted") {
                return Err(loopback_error());
            }
            Ok(wit::HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: wit::ByteList::new(b"accepted".to_vec()).expect("bounded loopback body"),
                truncated: false,
            })
        })
    }
}

fn loopback_error() -> wit::HttpError {
    wit::HttpError {
        code: wit::HttpErrorCode::Unavailable,
        delivery: wit::DeliveryState::NotSent,
        retryable: false,
        message: "Slice 2E loopback transport failed".to_owned(),
    }
}

async fn loopback_server() -> (String, Arc<LoopbackHttp>, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind loopback fixture");
    let address = listener.local_addr().expect("loopback address");
    let origin = format!("https://slice2e.test:{}", address.port());
    let (captured, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let (mut stream, peer) = listener.accept().await.expect("loopback accept");
        assert!(peer.ip().is_loopback());
        let mut bytes = Vec::new();
        let mut block = [0_u8; 1024];
        loop {
            let count = stream.read(&mut block).await.expect("loopback read");
            assert_ne!(count, 0, "loopback request truncated");
            bytes.extend_from_slice(&block[..count]);
            if bytes
                .windows(b"\r\n\r\n".len())
                .any(|part| part == b"\r\n\r\n")
                && bytes.ends_with(b"slice2e")
            {
                break;
            }
        }
        let request = String::from_utf8(bytes).expect("ASCII loopback request");
        assert!(request.starts_with("POST /slice2e?delivery=once HTTP/1.1\r\n"));
        let delivery_id = request
            .lines()
            .find_map(|line| line.strip_prefix("x-junban-plugin-delivery-id: "))
            .expect("delivery identity header")
            .to_owned();
        assert_eq!(delivery_id.len(), 64);
        assert!(delivery_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\naccepted")
            .await
            .expect("loopback response");
        stream.shutdown().await.expect("loopback shutdown");
        let _ = captured.send(delivery_id);
    });
    (origin, Arc::new(LoopbackHttp { address }), receiver)
}

#[cfg(unix)]
fn process_absent(pid: u32) -> bool {
    !Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .expect("probe host process")
        .status
        .success()
}

#[cfg(windows)]
fn process_absent(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("query Windows process");
    let text = String::from_utf8_lossy(&output.stdout);
    !text
        .lines()
        .any(|line| line.contains(&format!("\"{pid}\"")))
}

#[cfg(unix)]
fn kill_process(pid: u32) {
    assert!(
        Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .output()
            .expect("kill host process")
            .status
            .success()
    );
}

#[cfg(windows)]
fn kill_process(pid: u32) {
    assert!(
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .status()
            .expect("kill Windows host")
            .success()
    );
}

fn assert_command_ok(outcome: &GuestInvocationOutcome) {
    assert!(matches!(
        outcome,
        GuestInvocationOutcome::InvokeCommand(WitResult::Ok(_))
    ));
}

async fn create_task(service: &AppService, title: &str) {
    service
        .create_task(
            OperationId::new(),
            TaskDraft::new(TaskTitle::new(title).expect("task title")),
        )
        .await
        .expect("create typed task");
}

async fn composition_scenario(paths: &FixturePaths) {
    let profile = ProfileGuard::new("composition");
    let owner = ProfileOwner::open(profile.path()).expect("open composition profile");
    let service = app_service(&owner);
    let key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
    initialize_plugin_policy(&service, &key).await;
    create_task(&service, "slice2e-seed").await;

    let rust_component = fs::read(&paths.rust).expect("read Rust fixture");
    let typescript_component = fs::read(&paths.typescript).expect("read TypeScript fixture");
    let conformance_component = fs::read(&paths.conformance).expect("read conformance fixture");
    let (origin, http, delivery) = loopback_server().await;

    let root = install_plugin(
        &service,
        profile.path(),
        root_manifest("slice2e-root", &rust_component, &key),
        &rust_component,
        &key,
    )
    .await;
    let pids = Arc::new(Mutex::new(Vec::new()));
    let callbacks = BarrierCallbacks::new(service.clone());
    let supervisor = PluginRuntimeSupervisor::for_test_with_http(
        Arc::new(service.clone()),
        launch_policy(&paths.host, Arc::clone(&pids)),
        callbacks.clone(),
        http,
    );
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("root reconciliation")
            .graph_size,
        1
    );

    let conformance = install_plugin(
        &service,
        profile.path(),
        conformance_manifest(
            "slice2e-conformance",
            "slice2e-root",
            &origin,
            &conformance_component,
            &key,
        ),
        &conformance_component,
        &key,
    )
    .await;
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("conformance reconciliation")
            .graph_size,
        2
    );
    let typescript = install_plugin(
        &service,
        profile.path(),
        typescript_manifest(
            "slice2e-typescript",
            "slice2e-root",
            &typescript_component,
            &key,
        ),
        &typescript_component,
        &key,
    )
    .await;

    let snapshot = supervisor
        .reconcile()
        .await
        .expect("initial real reconciliation");
    assert_eq!(snapshot.lifecycle, PluginRuntimeLifecycle::Running);
    assert_eq!(snapshot.graph_size, 3);
    assert_eq!(snapshot.admitting_plugins.len(), 3);

    assert_command_ok(&invoke_completed(&supervisor, &root, "normal", Vec::new()).await);
    assert_command_ok(&invoke_completed(&supervisor, &typescript, "normal", Vec::new()).await);
    assert_command_ok(&invoke_completed(&supervisor, &conformance, "kv-effect", Vec::new()).await);
    let kv = service
        .list_plugin_kv(conformance.plugin_id.clone())
        .await
        .expect("list returned KV");
    assert_eq!(
        kv_value(&kv, "returned-kv").as_deref(),
        Some(b"component-value".as_slice())
    );
    assert_command_ok(&invoke_completed(&supervisor, &conformance, "ordinary", Vec::new()).await);

    assert_command_ok(
        &invoke_completed(&supervisor, &conformance, "domain-effect", Vec::new()).await,
    );
    assert!(
        service
            .list_tasks_simple()
            .await
            .expect("list tasks after plugin effect")
            .tasks
            .iter()
            .any(|task| task.title.as_str() == "slice2e-domain-effect")
    );

    supervisor
        .reconcile()
        .await
        .expect("retained-event catch-up after domain effect");
    let cursor = service
        .get_plugin_cursor(conformance.plugin_id.clone())
        .await
        .expect("successful event cursor");
    assert!(!cursor.resync_required);
    assert_eq!(
        cursor.revision,
        service
            .get_sync_state()
            .await
            .expect("sync state after catch-up")
            .revision
    );
    let event_kv = service
        .list_plugin_kv(conformance.plugin_id.clone())
        .await
        .expect("event effect KV");
    assert_eq!(
        kv_value(&event_kv, "event-count").as_deref(),
        Some(b"1".as_slice())
    );

    let committed_cursor = cursor.revision;
    create_task(&service, "slice2e-event-trap").await;
    supervisor
        .reconcile()
        .await
        .expect("event trap isolates plugin rather than graph");
    let failed_cursor = service
        .get_plugin_cursor(conformance.plugin_id.clone())
        .await
        .expect("failed event cursor");
    assert_eq!(failed_cursor.revision, committed_cursor);
    assert_eq!(
        kv_value(
            &service
                .list_plugin_kv(conformance.plugin_id.clone())
                .await
                .expect("failed event effect lookup"),
            "event-count",
        )
        .as_deref(),
        Some(b"1".as_slice())
    );
    let failed = service
        .get_installed_plugin(conformance.plugin_id.clone())
        .await
        .expect("event-failed plugin");
    assert!(matches!(
        failed.runtime_state,
        PluginRuntimeState::Degraded | PluginRuntimeState::Failed
    ));
    assert_command_ok(&invoke_completed(&supervisor, &root, "normal", Vec::new()).await);
    assert_command_ok(&invoke_completed(&supervisor, &typescript, "normal", Vec::new()).await);

    service
        .retry_plugin(
            OperationId::new(),
            conformance.plugin_id.clone(),
            Timestamp::now(),
        )
        .await
        .expect("typed retry after retained-event trap");
    supervisor
        .reconcile()
        .await
        .expect("fresh Store after retained-event trap");
    let mut conformance = service
        .get_installed_plugin(conformance.plugin_id.clone())
        .await
        .expect("retried conformance plugin");

    assert_command_ok(
        &invoke_completed(
            &supervisor,
            &conformance,
            "nested",
            vec![string_value("target", "slice2e-root")],
        )
        .await,
    );
    assert_eq!(
        kv_value(
            &service
                .list_plugin_kv(conformance.plugin_id.clone())
                .await
                .expect("Rust nested service result"),
            "nested-service",
        )
        .as_deref(),
        // The root was already durably active when this replacement child was
        // built, so a fresh Store correctly starts without replaying activate.
        Some(b"0".as_slice())
    );
    assert_command_ok(
        &invoke_completed(
            &supervisor,
            &conformance,
            "http",
            vec![string_value("origin", &origin)],
        )
        .await,
    );
    let delivery_id = tokio::time::timeout(TEST_WAIT, delivery)
        .await
        .expect("loopback delivery deadline")
        .expect("loopback delivery identity");
    assert_eq!(delivery_id.len(), 64);

    callbacks.block();
    let pre_dispatch = supervisor
        .invoke(command_dispatch(&conformance, "block", Vec::new()))
        .await
        .expect("pre-dispatch cancellation admission");
    pre_dispatch.cancel();
    assert!(matches!(
        terminal(pre_dispatch).await,
        InvocationOutcome::Cancelled
    ));
    assert!(callbacks.entered.try_acquire().is_err());
    wait_quiescent(&supervisor).await;

    let blocked = supervisor
        .invoke(command_dispatch(&conformance, "block", Vec::new()))
        .await
        .expect("blocked callback admission");
    callbacks.wait_entries(1).await;
    blocked.cancel();
    assert!(matches!(
        terminal(blocked).await,
        InvocationOutcome::Cancelled
    ));
    wait_quiescent(&supervisor).await;
    callbacks.unblock();
    assert!(
        kv_value(
            &service
                .list_plugin_kv(conformance.plugin_id.clone())
                .await
                .expect("cancelled effect lookup"),
            "blocked-effect",
        )
        .is_none()
    );
    assert_command_ok(&invoke_completed(&supervisor, &conformance, "state", Vec::new()).await);
    let state = kv_value(
        &service
            .list_plugin_kv(conformance.plugin_id.clone())
            .await
            .expect("replacement state"),
        "component-state",
    )
    .expect("replacement state KV");
    let state = String::from_utf8(state).expect("state text");
    assert!(state.contains("activations=0"));
    assert!(state.contains("dirty=0"));

    let trap = terminal(
        supervisor
            .invoke(command_dispatch(&conformance, "trap", Vec::new()))
            .await
            .expect("trap admission"),
    )
    .await;
    assert!(matches!(
        trap,
        InvocationOutcome::Failed(InvocationFailure::GuestTrap)
    ));
    assert_command_ok(&invoke_completed(&supervisor, &root, "normal", Vec::new()).await);

    service
        .retry_plugin(
            OperationId::new(),
            conformance.plugin_id.clone(),
            Timestamp::now(),
        )
        .await
        .expect("typed retry after guest trap");
    supervisor
        .reconcile()
        .await
        .expect("fresh graph after guest trap");
    conformance = service
        .get_installed_plugin(conformance.plugin_id.clone())
        .await
        .expect("post-trap plugin authority");
    assert_command_ok(&invoke_completed(&supervisor, &conformance, "state", Vec::new()).await);
    let state = String::from_utf8(
        kv_value(
            &service
                .list_plugin_kv(conformance.plugin_id.clone())
                .await
                .expect("post-trap state"),
            "component-state",
        )
        .expect("post-trap state KV"),
    )
    .expect("post-trap state text");
    assert!(state.contains("activations=1"));
    assert!(state.contains("dirty=0"));

    supervisor.shutdown().await.expect("composition shutdown");
    for pid in pids.lock().expect("composition PID log").iter().copied() {
        assert!(process_absent(pid), "composition host {pid} was not reaped");
    }
    drop(supervisor);
    drop(service);
    drop(owner);
}

async fn fault_scenario(paths: &FixturePaths) {
    let profile = ProfileGuard::new("faults");
    let owner = ProfileOwner::open(profile.path()).expect("open fault profile");
    let service = app_service(&owner);
    let key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
    initialize_plugin_policy(&service, &key).await;
    create_task(&service, "slice2e-fault-seed").await;
    let rust_component = fs::read(&paths.rust).expect("read Rust fixture");
    let conformance_component = fs::read(&paths.conformance).expect("read conformance fixture");
    let root = install_plugin(
        &service,
        profile.path(),
        root_manifest("fault-root", &rust_component, &key),
        &rust_component,
        &key,
    )
    .await;
    let pids = Arc::new(Mutex::new(Vec::new()));
    let callbacks = BarrierCallbacks::new(service.clone());
    let supervisor = PluginRuntimeSupervisor::for_test(
        Arc::new(service.clone()),
        launch_policy(&paths.host, Arc::clone(&pids)),
        callbacks.clone(),
    );
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("fault root graph")
            .graph_size,
        1
    );

    let mut plugins = Vec::new();
    for index in 0..6 {
        let id = format!("fault-{index:02}");
        plugins.push(
            install_plugin(
                &service,
                profile.path(),
                conformance_manifest(
                    &id,
                    "fault-root",
                    "https://slice2e.test:4443",
                    &conformance_component,
                    &key,
                ),
                &conformance_component,
                &key,
            )
            .await,
        );
    }
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("fault graph")
            .graph_size,
        7
    );

    let timeout_cursor = service
        .get_plugin_cursor(plugins[0].plugin_id.clone())
        .await
        .expect("pre-timeout cursor");
    create_task(&service, "slice2e-event-timeout").await;
    let timeout_revision = service
        .get_sync_state()
        .await
        .expect("timeout source revision")
        .revision;
    supervisor
        .reconcile()
        .await
        .expect("Wasm event timeout isolates one plugin");
    let timed_out = service
        .get_installed_plugin(plugins[0].plugin_id.clone())
        .await
        .expect("timed-out plugin state");
    assert_eq!(timed_out.last_error_code.as_deref(), Some("timeout"));
    let failed_timeout_cursor = service
        .get_plugin_cursor(plugins[0].plugin_id.clone())
        .await
        .expect("failed timeout cursor");
    assert!(failed_timeout_cursor.revision >= timeout_cursor.revision);
    assert_eq!(failed_timeout_cursor.revision + 1, timeout_revision);
    assert!(
        kv_value(
            &service
                .list_plugin_kv(plugins[0].plugin_id.clone())
                .await
                .expect("failed timeout effect lookup"),
            "event-count",
        )
        .is_none()
    );
    assert_command_ok(&invoke_completed(&supervisor, &plugins[5], "ping", Vec::new()).await);

    assert!(matches!(
        terminal(
            supervisor
                .invoke(command_dispatch(
                    &plugins[1],
                    "oversized-output",
                    Vec::new()
                ))
                .await
                .expect("oversized-output admission")
        )
        .await,
        InvocationOutcome::Failed(InvocationFailure::ResourceLimit)
    ));
    assert!(
        kv_value(
            &service
                .list_plugin_kv(plugins[1].plugin_id.clone())
                .await
                .expect("oversized-output effect lookup"),
            "oversized"
        )
        .is_none()
    );
    assert_command_ok(&invoke_completed(&supervisor, &plugins[5], "ping", Vec::new()).await);

    assert!(matches!(
        terminal(
            supervisor
                .invoke(command_dispatch(&plugins[2], "memory-grow", Vec::new()))
                .await
                .expect("memory resource admission")
        )
        .await,
        InvocationOutcome::Failed(InvocationFailure::ResourceLimit)
    ));
    assert_command_ok(&invoke_completed(&supervisor, &plugins[5], "ping", Vec::new()).await);

    callbacks.fail_one();
    assert!(matches!(
        terminal(
            supervisor
                .invoke(command_dispatch(&plugins[3], "callback-error", Vec::new()))
                .await
                .expect("callback resource failure admission")
        )
        .await,
        InvocationOutcome::Failed(InvocationFailure::InvalidOutput)
    ));
    assert_command_ok(&invoke_completed(&supervisor, &plugins[5], "ping", Vec::new()).await);

    service
        .retry_plugin(
            OperationId::new(),
            plugins[0].plugin_id.clone(),
            Timestamp::now(),
        )
        .await
        .expect("retry timed-out plugin");
    supervisor
        .reconcile()
        .await
        .expect("replace timed-out Store");
    plugins[0] = service
        .get_installed_plugin(plugins[0].plugin_id.clone())
        .await
        .expect("refreshed timeout plugin authority");
    assert_command_ok(&invoke_completed(&supervisor, &plugins[0], "state", Vec::new()).await);
    let replacement_state = String::from_utf8(
        kv_value(
            &service
                .list_plugin_kv(plugins[0].plugin_id.clone())
                .await
                .expect("replacement Store state"),
            "component-state",
        )
        .expect("replacement Store state KV"),
    )
    .expect("replacement Store state text");
    assert!(replacement_state.contains("dirty=0"));
    assert_command_ok(&invoke_completed(&supervisor, &root, "normal", Vec::new()).await);
    supervisor.shutdown().await.expect("fault graph shutdown");
    for pid in pids.lock().expect("fault PID log").iter().copied() {
        assert!(process_absent(pid), "fault host {pid} was not reaped");
    }
    drop(supervisor);
    drop(service);
    drop(owner);
}

async fn scaling_and_admission_scenario(paths: &FixturePaths) {
    let profile = ProfileGuard::new("scaling");
    let owner = ProfileOwner::open(profile.path()).expect("open scaling profile");
    let service = app_service(&owner);
    let key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
    initialize_plugin_policy(&service, &key).await;
    create_task(&service, "slice2e-scale-seed").await;
    let rust_component = fs::read(&paths.rust).expect("read Rust fixture");
    let conformance_component = fs::read(&paths.conformance).expect("read conformance fixture");
    let root = install_plugin(
        &service,
        profile.path(),
        root_manifest("scale-root", &rust_component, &key),
        &rust_component,
        &key,
    )
    .await;
    let pids = Arc::new(Mutex::new(Vec::new()));
    let callbacks = BarrierCallbacks::new(service.clone());
    let supervisor = PluginRuntimeSupervisor::for_test(
        Arc::new(service.clone()),
        launch_policy(&paths.host, Arc::clone(&pids)),
        callbacks.clone(),
    );
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("one-plugin graph")
            .graph_size,
        1
    );
    assert_command_ok(&invoke_completed(&supervisor, &root, "normal", Vec::new()).await);

    let mut plugins = Vec::new();
    for index in 0..3 {
        let id = format!("scale-{index:02}");
        plugins.push(
            install_plugin(
                &service,
                profile.path(),
                conformance_manifest(
                    &id,
                    "scale-root",
                    "https://slice2e.test:4443",
                    &conformance_component,
                    &key,
                ),
                &conformance_component,
                &key,
            )
            .await,
        );
    }
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("four-plugin graph")
            .graph_size,
        4
    );
    assert_command_ok(&invoke_completed(&supervisor, &plugins[0], "state", Vec::new()).await);

    for index in 3..15 {
        let id = format!("scale-{index:02}");
        plugins.push(
            install_plugin(
                &service,
                profile.path(),
                conformance_manifest(
                    &id,
                    "scale-root",
                    "https://slice2e.test:4443",
                    &conformance_component,
                    &key,
                ),
                &conformance_component,
                &key,
            )
            .await,
        );
    }
    let snapshot = supervisor.reconcile().await.expect("sixteen-plugin graph");
    assert_eq!(snapshot.graph_size, 16);
    assert_eq!(snapshot.admitting_plugins.len(), 16);

    callbacks.block();
    let mut handles = vec![
        supervisor
            .invoke(command_dispatch(&plugins[0], "block", Vec::new()))
            .await
            .expect("same-plugin held admission"),
    ];
    callbacks.wait_entries(1).await;
    assert!(matches!(
        supervisor
            .invoke(command_dispatch(&plugins[0], "state", Vec::new()))
            .await,
        Err(PluginRuntimeError::PluginBusy)
    ));
    for plugin in &plugins[1..4] {
        handles.push(
            supervisor
                .invoke(command_dispatch(plugin, "block", Vec::new()))
                .await
                .expect("four-way admission"),
        );
    }
    callbacks.wait_entries(3).await;
    assert!(matches!(
        supervisor
            .invoke(command_dispatch(&plugins[4], "state", Vec::new()))
            .await,
        Err(PluginRuntimeError::InvocationLimit)
    ));
    for handle in &handles {
        handle.cancel();
    }
    for handle in handles {
        assert!(matches!(
            terminal(handle).await,
            InvocationOutcome::Cancelled
        ));
    }
    wait_quiescent(&supervisor).await;
    callbacks.unblock();

    assert_command_ok(&invoke_completed(&supervisor, &plugins[0], "state", Vec::new()).await);
    let replaced = String::from_utf8(
        kv_value(
            &service
                .list_plugin_kv(plugins[0].plugin_id.clone())
                .await
                .expect("cancel replacement state"),
            "component-state",
        )
        .expect("cancel replacement state KV"),
    )
    .expect("cancel replacement state text");
    assert!(replaced.contains("activations=0"));
    assert!(replaced.contains("dirty=0"));
    assert_command_ok(&invoke_completed(&supervisor, &plugins[5], "ping", Vec::new()).await);

    supervisor.shutdown().await.expect("scaling shutdown");
    let launched = pids.lock().expect("scaling PID log").clone();
    assert_eq!(launched.len(), 3);
    for pid in launched {
        assert!(process_absent(pid), "scaling host {pid} was not reaped");
    }
    drop(supervisor);
    drop(service);
    drop(owner);
}

async fn real_child_kill_scenario(paths: &FixturePaths) {
    let profile = ProfileGuard::new("kill");
    let owner = ProfileOwner::open(profile.path()).expect("open kill profile");
    let service = app_service(&owner);
    let key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
    initialize_plugin_policy(&service, &key).await;
    create_task(&service, "slice2e-kill-seed").await;
    let rust_component = fs::read(&paths.rust).expect("read Rust fixture");
    let conformance_component = fs::read(&paths.conformance).expect("read conformance fixture");
    let _root = install_plugin(
        &service,
        profile.path(),
        root_manifest("kill-root", &rust_component, &key),
        &rust_component,
        &key,
    )
    .await;
    let pids = Arc::new(Mutex::new(Vec::new()));
    let callbacks = BarrierCallbacks::new(service.clone());
    let supervisor = PluginRuntimeSupervisor::for_test(
        Arc::new(service.clone()),
        launch_policy(&paths.host, Arc::clone(&pids)),
        callbacks.clone(),
    );
    assert_eq!(
        supervisor
            .reconcile()
            .await
            .expect("kill root graph")
            .graph_size,
        1
    );
    let plugin = install_plugin(
        &service,
        profile.path(),
        conformance_manifest(
            "kill-conformance",
            "kill-root",
            "https://slice2e.test:4443",
            &conformance_component,
            &key,
        ),
        &conformance_component,
        &key,
    )
    .await;
    assert_eq!(
        supervisor.reconcile().await.expect("kill graph").graph_size,
        2
    );
    callbacks.block();
    let handle = supervisor
        .invoke(command_dispatch(&plugin, "block", Vec::new()))
        .await
        .expect("kill invocation admission");
    callbacks.wait_entries(1).await;
    let pid = *pids
        .lock()
        .expect("kill PID log")
        .last()
        .expect("active kill host PID");
    kill_process(pid);
    assert!(matches!(
        terminal(handle).await,
        InvocationOutcome::Failed(InvocationFailure::SessionLost)
    ));
    match supervisor.snapshot().await {
        Ok(snapshot) => assert_eq!(snapshot.lifecycle, PluginRuntimeLifecycle::Dormant),
        Err(PluginRuntimeError::Closed) => {}
        Err(error) => panic!("unexpected post-kill supervisor state: {error:?}"),
    }
    assert!(process_absent(pid), "killed host was not reaped");
    assert!(matches!(
        supervisor.shutdown().await,
        Ok(()) | Err(PluginRuntimeError::Closed)
    ));
    assert!(process_absent(pid));
    drop(supervisor);
    drop(service);
    drop(owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn phase7_slice2e_real_production_composition() {
    let Some(paths) = FixturePaths::from_environment() else {
        return;
    };
    assert_fixture_imports(&paths);
    eprintln!("slice2e: composition");
    composition_scenario(&paths).await;
    eprintln!("slice2e: fault coverage");
    fault_scenario(&paths).await;
    eprintln!("slice2e: scaling and admission");
    scaling_and_admission_scenario(&paths).await;
    eprintln!("slice2e: child kill and reap");
    real_child_kill_scenario(&paths).await;
    println!(
        "SLICE2E_RESULT_JSON={}",
        serde_json::json!({
            "schema_version": 1,
            "status": "passed",
            "cases": CASE_INVENTORY,
            "wasmtime": "36.0.13",
            "process_model": "one-on-demand-child-per-profile",
            "fixture_profiles": ["rust", "typescript"],
            "scales": [1, 4, 16],
            "cleanup": "all-children-reaped",
        })
    );
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "Linux cgroup-v2 calibration is an explicit evidence campaign"]
async fn phase7_slice2e_linux_cgroup_calibration_probe() {
    if env::var("JUNBAN_SLICE2E_CALIBRATION").ok().as_deref() != Some("1") {
        return;
    }
    let paths = FixturePaths::from_environment().expect("calibration fixture paths");
    let profile_name = env::var("JUNBAN_SLICE2E_CALIBRATION_PROFILE")
        .expect("JUNBAN_SLICE2E_CALIBRATION_PROFILE is required");
    let scale: usize = env::var("JUNBAN_SLICE2E_CALIBRATION_SCALE")
        .expect("JUNBAN_SLICE2E_CALIBRATION_SCALE is required")
        .parse()
        .expect("calibration scale must be an integer");
    assert!(
        [0, 1, 4, 16].contains(&scale),
        "unsupported calibration scale"
    );

    let profile = ProfileGuard::new(&format!("calibration-{profile_name}-{scale}"));
    let owner = ProfileOwner::open(profile.path()).expect("open calibration profile");
    let service = app_service(&owner);
    let key = SigningKey::from_bytes(&SIGNING_KEY_BYTES);
    initialize_plugin_policy(&service, &key).await;
    create_task(&service, "slice2e-calibration-seed").await;

    let mut supervisor = None;
    let mut graph_size = 0;
    if profile_name != "baseline" {
        assert!([1, 4, 16].contains(&scale));
        let rust_component = fs::read(&paths.rust).expect("read calibration Rust fixture");
        let typescript_component =
            fs::read(&paths.typescript).expect("read calibration TypeScript fixture");
        let typescript_standalone_component = fs::read(&paths.typescript_standalone)
            .expect("read standalone calibration TypeScript fixture");
        let pids = Arc::new(Mutex::new(Vec::new()));
        let runtime = PluginRuntimeSupervisor::for_test(
            Arc::new(service.clone()),
            launch_policy(&paths.host, pids),
            Arc::new(service.clone()),
        );
        if profile_name == "rust" {
            for index in 0..scale {
                let id = format!("calibration-rust-{index:02}");
                install_plugin(
                    &service,
                    profile.path(),
                    root_manifest(&id, &rust_component, &key),
                    &rust_component,
                    &key,
                )
                .await;
            }
            graph_size = runtime
                .reconcile()
                .await
                .expect("load Rust calibration graph")
                .graph_size;
        } else {
            assert_eq!(
                profile_name, "typescript",
                "unsupported calibration profile"
            );
            if scale == 1 {
                install_plugin(
                    &service,
                    profile.path(),
                    typescript_standalone_manifest(
                        "calibration-typescript-standalone",
                        &typescript_standalone_component,
                        &key,
                    ),
                    &typescript_standalone_component,
                    &key,
                )
                .await;
            } else {
                install_plugin(
                    &service,
                    profile.path(),
                    root_manifest("calibration-root", &rust_component, &key),
                    &rust_component,
                    &key,
                )
                .await;
                assert_eq!(
                    runtime
                        .reconcile()
                        .await
                        .expect("load calibration support root")
                        .graph_size,
                    1
                );
                for index in 0..(scale - 1) {
                    let id = format!("calibration-typescript-{index:02}");
                    install_plugin(
                        &service,
                        profile.path(),
                        typescript_manifest(&id, "calibration-root", &typescript_component, &key),
                        &typescript_component,
                        &key,
                    )
                    .await;
                }
            }
            graph_size = runtime
                .reconcile()
                .await
                .expect("load TypeScript calibration graph")
                .graph_size;
        }
        assert_eq!(graph_size, scale, "plugin_scale is the total loaded graph");
        supervisor = Some(runtime);
    } else {
        assert_eq!(scale, 0, "baseline scale must be zero");
    }

    let support_plugins = usize::from(profile_name == "typescript" && scale > 1);
    println!(
        "SLICE2E_CALIBRATION_READY={{\"profile\":\"{profile_name}\",\"scale\":{scale},\"graph_size\":{graph_size},\"support_plugins\":{support_plugins}}}"
    );
    std::io::Write::flush(&mut std::io::stdout()).expect("flush calibration marker");
    let mut release = String::new();
    std::io::stdin()
        .read_line(&mut release)
        .expect("read calibration release");
    assert_eq!(release, "release\n", "invalid calibration release marker");

    if let Some(runtime) = supervisor {
        let shutdown = runtime.shutdown().await;
        assert!(
            shutdown.is_ok() || shutdown == Err(PluginRuntimeError::Closed),
            "calibration shutdown: {shutdown:?}"
        );
    }
    drop(service);
    drop(owner);
}
