//! Typed application/storage authority for normalized plugin persistence.
//!
//! This module deliberately contains no runtime host, transport, registry, or UI
//! wrappers. The SQLite owner implements [`PluginRepository`]; later runtime
//! waves consume this bounded port.

use std::cmp::Ordering;

use jiff::Timestamp;
use junban_domain::{OperationId, Project, ProjectId, Tag, TagId, Task, TaskDraft, TaskId};
use junban_plugin_sdk::{
    Capability, DependencyLock, GraphError, InvocationKind, OutcomeKind, Permission, PluginId,
    RuntimeManifest, SdkError, SettingValue, Sha256Digest, compare_versions, inspect_component,
    outcome_authority, parse_package, permission_set_hash, signer_key_id, verify_package,
    version_matches,
};
use serde::{Deserialize, Serialize};

use crate::{
    BulkAction, CommittedMutation, ProjectDraft, ProjectPatch, RepositoryError, RepositoryFuture,
    TagDraft, TagPatch, TaskPatch, TemporalContext,
};

pub const PLUGINS_INSTALLED_MAX: usize = 64;
pub const PLUGINS_ENABLED_MAX: usize = 16;
pub const PLUGIN_SETTINGS_KEYS_MAX: usize = 64;
pub const PLUGIN_SETTINGS_BYTES_MAX: usize = 64 * 1024;
pub const PLUGIN_KV_KEYS_MAX: usize = 256;
pub const PLUGIN_KV_VALUE_BYTES_MAX: usize = 64 * 1024;
pub const PLUGIN_KV_BYTES_MAX: usize = 2 * 1024 * 1024;
pub const PLUGIN_INVOCATIONS_PER_PLUGIN_MAX: usize = 64;
pub const PLUGIN_INVOCATIONS_MAX: usize = 256;
pub const PLUGIN_INVOCATION_MATERIAL_PER_PLUGIN_BYTES_MAX: usize = 1024 * 1024;
pub const PLUGIN_INVOCATION_MATERIAL_BYTES_MAX: usize = 4 * 1024 * 1024;
pub const PLUGIN_INVOCATION_RETENTION_DAYS: i64 = 30;
pub const PLUGIN_RESYNC_PAGE_ITEMS_MAX: usize = 100;
pub const PLUGIN_RESYNC_PAGE_BYTES_MAX: usize = 256 * 1024;
pub const PLUGIN_DEPENDENTS_MAX: usize = 64;

/// Fully inspected package metadata. Construction verifies JBP1 signature,
/// canonical manifest/hash identities, component shape, and Junban compatibility.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PluginPackageAuthority {
    plugin_id: PluginId,
    manifest: RuntimeManifest,
    package_sha256: Sha256Digest,
    manifest_sha256: Sha256Digest,
    component_sha256: Sha256Digest,
    publisher_key_id: Sha256Digest,
    #[serde(skip)]
    publisher_public_key: [u8; 32],
    package_size: u64,
    component_size: u64,
}

impl PluginPackageAuthority {
    pub fn inspect(bytes: &[u8]) -> Result<Self, SdkError> {
        let publisher_public_key = *parse_package(bytes)?.public_key;
        let package = verify_package(bytes)?;
        inspect_component(package.component_bytes, &package.manifest)?;
        if !version_matches(
            &package.manifest.junban_compatibility,
            env!("CARGO_PKG_VERSION"),
        )? {
            return Err(SdkError::Manifest {
                field: "compatibility.junban",
            });
        }
        Ok(Self {
            plugin_id: PluginId::parse(package.manifest.id.clone())?,
            manifest: package.manifest,
            package_sha256: Sha256Digest::parse(package.identities.package_sha256)?,
            manifest_sha256: Sha256Digest::parse(package.identities.manifest_sha256)?,
            component_sha256: Sha256Digest::parse(package.identities.component_sha256)?,
            publisher_key_id: Sha256Digest::parse(package.identities.key_id)?,
            publisher_public_key,
            package_size: package.identities.package_size,
            component_size: package.identities.component_size,
        })
    }

    #[must_use]
    pub fn plugin_id(&self) -> &PluginId {
        &self.plugin_id
    }

    #[must_use]
    pub fn manifest(&self) -> &RuntimeManifest {
        &self.manifest
    }

    #[must_use]
    pub fn package_sha256(&self) -> &Sha256Digest {
        &self.package_sha256
    }

    #[must_use]
    pub fn manifest_sha256(&self) -> &Sha256Digest {
        &self.manifest_sha256
    }

    #[must_use]
    pub fn component_sha256(&self) -> &Sha256Digest {
        &self.component_sha256
    }

    #[must_use]
    pub fn publisher_key_id(&self) -> &Sha256Digest {
        &self.publisher_key_id
    }

    #[must_use]
    pub const fn publisher_public_key(&self) -> &[u8; 32] {
        &self.publisher_public_key
    }

    #[must_use]
    pub const fn package_size(&self) -> u64 {
        self.package_size
    }

    #[must_use]
    pub const fn component_size(&self) -> u64 {
        self.component_size
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallSource {
    BundledRegistry,
    CommunityRegistry,
    LocalPackage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstallPluginRequest {
    pub package: PluginPackageAuthority,
    pub source: PluginInstallSource,
    /// A same-package replacement still allocates a fresh global generation.
    /// Publisher rotation requires dependent-safe uninstall and fresh install.
    pub replace_existing: bool,
    pub allow_downgrade: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntimeState {
    Disabled,
    Starting,
    Active,
    Degraded,
    Failed,
    Suspended,
    ReverifyRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherTrustStatus {
    Active,
    Revoked,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstalledPlugin {
    pub plugin_id: PluginId,
    pub manifest: RuntimeManifest,
    pub version: String,
    pub package_sha256: Sha256Digest,
    pub component_sha256: Sha256Digest,
    pub publisher_key_id: Sha256Digest,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub desired_enabled: bool,
    pub runtime_state: PluginRuntimeState,
    pub granted_capabilities: Vec<Capability>,
    pub dependencies_satisfied: bool,
    pub failure_count: u32,
    pub last_error_code: Option<String>,
    pub next_retry_at: Option<Timestamp>,
    pub installed_at: Timestamp,
    pub updated_at: Timestamp,
}

impl InstalledPlugin {
    #[must_use]
    pub fn summary(&self) -> PluginSummary {
        let mut requested_capabilities: Vec<_> = self
            .manifest
            .permissions
            .iter()
            .map(|permission| permission.capability)
            .collect();
        requested_capabilities.sort_unstable();
        requested_capabilities.dedup();
        let mut granted_capabilities = self.granted_capabilities.clone();
        granted_capabilities.sort_unstable();
        granted_capabilities.dedup();
        PluginSummary {
            plugin_id: self.plugin_id.clone(),
            name: self.manifest.name.clone(),
            version: self.version.clone(),
            package_generation: self.package_generation,
            activation_epoch: self.activation_epoch,
            desired_enabled: self.desired_enabled,
            runtime_state: self.runtime_state,
            requested_capabilities,
            granted_capabilities,
            dependencies: self
                .manifest
                .dependencies
                .iter()
                .map(|dependency| {
                    PluginId::parse(dependency.id.clone()).expect("validated dependency id")
                })
                .collect(),
            dependencies_satisfied: self.dependencies_satisfied,
            last_error_code: self.last_error_code.clone(),
        }
    }
}

/// Bounded event snapshot; the full manifest and private bookkeeping stay out of events.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginSummary {
    pub plugin_id: PluginId,
    pub name: String,
    pub version: String,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub desired_enabled: bool,
    pub runtime_state: PluginRuntimeState,
    pub requested_capabilities: Vec<Capability>,
    pub granted_capabilities: Vec<Capability>,
    pub dependencies: Vec<PluginId>,
    pub dependencies_satisfied: bool,
    pub last_error_code: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledPluginProfile {
    pub plugins: Vec<InstalledPlugin>,
    pub activation_order: Vec<PluginId>,
    pub community_policy: CommunityPluginPolicy,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublisherTrust {
    pub key_id: Sha256Digest,
    pub public_key: [u8; 32],
    pub status: PublisherTrustStatus,
    pub trusted_at: Timestamp,
    pub revoked_at: Option<Timestamp>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TrustPublisherRequest {
    pub key_id: Sha256Digest,
    pub public_key: [u8; 32],
}

impl TrustPublisherRequest {
    #[must_use]
    pub fn new(public_key: [u8; 32]) -> Self {
        Self {
            key_id: signer_key_id(&public_key),
            public_key,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct CommunityPluginPolicy {
    pub community_registry_enabled: bool,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginGrant {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub permission_hash: Sha256Digest,
    pub permission: Permission,
    pub granted_at: Timestamp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReplacePluginGrantsRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub permissions: Vec<Permission>,
    pub permission_hash: Sha256Digest,
}

impl ReplacePluginGrantsRequest {
    pub fn new(
        plugin_id: PluginId,
        package_generation: u64,
        package_permissions: &[Permission],
        permissions: Vec<Permission>,
    ) -> Result<Self, SdkError> {
        junban_plugin_sdk::validate_permission_grants(package_permissions, &permissions)?;
        let hash = permission_set_hash(package_permissions)?;
        Ok(Self {
            plugin_id,
            package_generation,
            permissions,
            permission_hash: Sha256Digest::from_bytes(hash),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RevokePluginGrantsRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub permission_hash: Sha256Digest,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PluginSetting {
    pub key: PluginId,
    pub value: SettingValue,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SetPluginSettingRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub key: PluginId,
    pub value: SettingValue,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DeletePluginSettingRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub key: PluginId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginKvEntry {
    pub key: String,
    pub value: Vec<u8>,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
pub struct PluginKvPatch {
    pub set: Vec<(String, Vec<u8>)>,
    pub delete: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginDependency {
    pub lock: DependencyLock,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginEventCursor {
    pub plugin_id: PluginId,
    pub event_epoch: String,
    pub revision: u64,
    pub resync_required: bool,
    pub updated_at: Timestamp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginCursorPosition {
    pub event_epoch: String,
    pub revision: u64,
    pub resync_required: bool,
}

impl From<&PluginEventCursor> for PluginCursorPosition {
    fn from(value: &PluginEventCursor) -> Self {
        Self {
            event_epoch: value.event_epoch.clone(),
            revision: value.revision,
            resync_required: value.resync_required,
        }
    }
}

/// One caller-owned, runtime-local resync identity sampled from SQLite atomically.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PluginResyncSession {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub expected_cursor: PluginCursorPosition,
    pub snapshot_event_epoch: String,
    pub snapshot_revision: u64,
}

/// Hash authority persisted on a resync invocation row.
#[must_use]
pub fn plugin_resync_request_hash(session: &PluginResyncSession) -> Sha256Digest {
    fn put(material: &mut Vec<u8>, value: &str) {
        material.extend_from_slice(
            &u64::try_from(value.len())
                .expect("resync identity fields fit in u64")
                .to_be_bytes(),
        );
        material.extend_from_slice(value.as_bytes());
    }

    let mut material = b"junban.plugin.resync.v1\0".to_vec();
    put(&mut material, &session.operation_id.to_string());
    put(&mut material, session.plugin_id.as_str());
    material.extend_from_slice(&session.package_generation.to_be_bytes());
    material.extend_from_slice(&session.activation_epoch.to_be_bytes());
    put(&mut material, &session.expected_cursor.event_epoch);
    material.extend_from_slice(&session.expected_cursor.revision.to_be_bytes());
    material.push(u8::from(session.expected_cursor.resync_required));
    put(&mut material, &session.snapshot_event_epoch);
    material.extend_from_slice(&session.snapshot_revision.to_be_bytes());
    Sha256Digest::of(&material)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BeginPluginResyncRequest {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
}

/// Stable WIT resource-kind order used by count/byte-bounded resync pages.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginSnapshotKind {
    Task,
    Project,
    Tag,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum PluginSnapshotItem {
    Task(Box<Task>),
    Project(Project),
    Tag(Tag),
}

impl PluginSnapshotItem {
    #[must_use]
    pub fn id(&self) -> String {
        match self {
            Self::Task(task) => task.id.to_string(),
            Self::Project(project) => project.id.to_string(),
            Self::Tag(tag) => tag.id.to_string(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginResyncPageRequest {
    pub session: PluginResyncSession,
    pub kind: PluginSnapshotKind,
    pub after_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PluginResyncPage {
    pub operation_id: OperationId,
    pub kind: PluginSnapshotKind,
    pub items: Vec<PluginSnapshotItem>,
    pub next_after_id: Option<String>,
    pub exhausted: bool,
    pub material_bytes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdvancePluginCursorRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub expected: PluginCursorPosition,
    pub next: PluginCursorPosition,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginHookKind {
    InvokeCommand,
    HandleEvent,
    HandleSurfaceAction,
    Resync,
}

impl PluginHookKind {
    #[must_use]
    pub const fn invocation_kind(self) -> InvocationKind {
        match self {
            Self::InvokeCommand => InvocationKind::InvokeCommand,
            Self::HandleEvent => InvocationKind::HandleEvent,
            Self::HandleSurfaceAction => InvocationKind::HandleSurfaceAction,
            Self::Resync => InvocationKind::Resync,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInvocationState {
    Reserved,
    DispatchingHttp,
    EffectCommitting,
    AmbiguousHttp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginInvocation {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub hook_kind: PluginHookKind,
    pub entry_id: PluginId,
    pub request_sha256: Sha256Digest,
    pub delivery_operation_id: OperationId,
    pub state: PluginInvocationState,
    pub error_code: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub retain_until: Timestamp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ReservePluginInvocationRequest {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub hook_kind: PluginHookKind,
    pub entry_id: PluginId,
    pub request_sha256: Sha256Digest,
    pub delivery_operation_id: OperationId,
    #[serde(skip)]
    pub resync_session: Option<PluginResyncSession>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservedPluginInvocation {
    pub invocation: PluginInvocation,
    pub replayed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransitionPluginInvocationRequest {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub expected_state: PluginInvocationState,
    pub next_state: PluginInvocationState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginBookkeepingUpdate {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub failure_count: u32,
    pub last_error_code: Option<String>,
    pub next_retry_at: Option<Timestamp>,
}

#[derive(Clone, Debug)]
pub enum PluginDomainEffect {
    CreateTask {
        task_id: TaskId,
        draft: TaskDraft,
    },
    PatchTask {
        task_id: TaskId,
        patch: TaskPatch,
    },
    CompleteTask {
        task_id: TaskId,
        temporal: TemporalContext,
    },
    UncompleteTask {
        task_id: TaskId,
        temporal: TemporalContext,
    },
    CancelTask {
        task_id: TaskId,
    },
    ReopenTask {
        task_id: TaskId,
    },
    DeleteTask {
        task_id: TaskId,
    },
    BulkTasks {
        task_ids: Vec<TaskId>,
        action: BulkAction,
        temporal: TemporalContext,
    },
    CreateProject {
        project_id: ProjectId,
        draft: ProjectDraft,
    },
    PatchProject {
        project_id: ProjectId,
        patch: ProjectPatch,
    },
    DeleteProject {
        project_id: ProjectId,
    },
    CreateTag {
        tag_id: TagId,
        draft: TagDraft,
    },
    PatchTag {
        tag_id: TagId,
        patch: TagPatch,
    },
    DeleteTag {
        tag_id: TagId,
    },
}

impl PluginDomainEffect {
    #[must_use]
    pub const fn outcome_kind(&self) -> OutcomeKind {
        match self {
            Self::CreateTask { .. } => OutcomeKind::CreateTask,
            Self::PatchTask { .. } => OutcomeKind::PatchTask,
            Self::CompleteTask { .. } => OutcomeKind::CompleteTask,
            Self::UncompleteTask { .. } => OutcomeKind::UncompleteTask,
            Self::CancelTask { .. } => OutcomeKind::CancelTask,
            Self::ReopenTask { .. } => OutcomeKind::ReopenTask,
            Self::DeleteTask { .. } => OutcomeKind::DeleteTask,
            Self::BulkTasks { .. } => OutcomeKind::BulkTasks,
            Self::CreateProject { .. } => OutcomeKind::CreateProject,
            Self::PatchProject { .. } => OutcomeKind::PatchProject,
            Self::DeleteProject { .. } => OutcomeKind::DeleteProject,
            Self::CreateTag { .. } => OutcomeKind::CreateTag,
            Self::PatchTag { .. } => OutcomeKind::PatchTag,
            Self::DeleteTag { .. } => OutcomeKind::DeleteTag,
        }
    }

    #[must_use]
    pub const fn required_capability(&self) -> Capability {
        outcome_authority(self.outcome_kind()).capability
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginResyncKvCommit {
    Leave,
    Replace(Vec<(String, Vec<u8>)>),
}

#[derive(Clone, Debug)]
pub struct CommitPluginInvocationRequest {
    pub invocation_operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub child_operation_id: Option<OperationId>,
    pub domain_effect: Option<PluginDomainEffect>,
    pub kv_patch: Option<PluginKvPatch>,
    pub resync_kv: Option<PluginResyncKvCommit>,
    pub cursor: Option<AdvancePluginCursorRequest>,
    pub resync_session: Option<PluginResyncSession>,
}

#[derive(Clone, Debug)]
pub struct CommittedPluginInvocation {
    pub mutation: Option<CommittedMutation>,
    pub cursor: Option<PluginEventCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginGraphRejection {
    TooManyNodes,
    DuplicatePlugin,
    SelfDependency,
    DuplicateDependency,
    MissingService,
    Fanout,
    InvalidPackageAuthority,
    UnresolvedDependencies {
        missing: Vec<(PluginId, PluginId)>,
        incompatible: Vec<(PluginId, PluginId, String, String)>,
    },
    Cycle,
    Depth,
    LockMismatch,
}

impl TryFrom<GraphError> for PluginGraphRejection {
    type Error = SdkError;

    fn try_from(error: GraphError) -> Result<Self, Self::Error> {
        Ok(match error {
            GraphError::TooManyNodes => Self::TooManyNodes,
            GraphError::DuplicatePlugin => Self::DuplicatePlugin,
            GraphError::SelfDependency => Self::SelfDependency,
            GraphError::DuplicateDependency => Self::DuplicateDependency,
            GraphError::MissingService => Self::MissingService,
            GraphError::Fanout => Self::Fanout,
            GraphError::InvalidPackageAuthority => Self::InvalidPackageAuthority,
            GraphError::UnresolvedDependencies {
                missing,
                incompatible,
            } => Self::UnresolvedDependencies {
                missing: missing
                    .into_iter()
                    .map(|item| {
                        Ok((
                            PluginId::parse(item.plugin_id)?,
                            PluginId::parse(item.dependency_id)?,
                        ))
                    })
                    .collect::<Result<_, SdkError>>()?,
                incompatible: incompatible
                    .into_iter()
                    .map(|item| {
                        Ok((
                            PluginId::parse(item.plugin_id)?,
                            PluginId::parse(item.dependency_id)?,
                            item.requirement,
                            item.installed_version,
                        ))
                    })
                    .collect::<Result<_, SdkError>>()?,
            },
            GraphError::Cycle => Self::Cycle,
            GraphError::Depth => Self::Depth,
            GraphError::LockMismatch => Self::LockMismatch,
        })
    }
}

#[derive(Clone, Debug)]
pub enum PluginMutationOutcome {
    Committed(Box<CommittedMutation>),
    BlockedByDependents(Vec<PluginId>),
    GraphRejected(PluginGraphRejection),
}

impl PluginMutationOutcome {
    #[must_use]
    pub fn committed(&self) -> Option<&CommittedMutation> {
        match self {
            Self::Committed(mutation) => Some(mutation),
            Self::BlockedByDependents(_) | Self::GraphRejected(_) => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginPackageReconciliation {
    pub checked: usize,
    pub disabled: Vec<PluginId>,
    pub orphan_files_removed: usize,
    pub cleanup_truncated: bool,
}

fn plugin_unavailable<T: Send + 'static>() -> RepositoryFuture<'static, T> {
    Box::pin(async {
        Err(RepositoryError::Storage(
            "plugin persistence is unavailable".to_owned(),
        ))
    })
}

/// Storage-only plugin persistence port. Defaults keep application test doubles
/// focused; the production SQLite repository overrides every method.
pub trait PluginRepository: Send + Sync + 'static {
    /// Verify and durably publish immutable JBP1 bytes before metadata admission.
    fn publish_plugin_package(
        &self,
        _bytes: Vec<u8>,
    ) -> RepositoryFuture<'_, PluginPackageAuthority> {
        plugin_unavailable()
    }

    /// Reverify referenced package objects and quarantine corrupt authority.
    fn reconcile_plugin_packages(
        &self,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginPackageReconciliation> {
        plugin_unavailable()
    }

    fn get_installed_plugin_profile(&self) -> RepositoryFuture<'_, InstalledPluginProfile> {
        plugin_unavailable()
    }

    fn get_installed_plugin(&self, _plugin_id: PluginId) -> RepositoryFuture<'_, InstalledPlugin> {
        plugin_unavailable()
    }

    fn install_plugin(
        &self,
        _operation_id: OperationId,
        _request: InstallPluginRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginMutationOutcome> {
        plugin_unavailable()
    }

    fn uninstall_plugin(
        &self,
        _operation_id: OperationId,
        _plugin_id: PluginId,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginMutationOutcome> {
        plugin_unavailable()
    }

    fn set_plugin_desired_enabled(
        &self,
        _operation_id: OperationId,
        _plugin_id: PluginId,
        _enabled: bool,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginMutationOutcome> {
        plugin_unavailable()
    }

    fn retry_plugin(
        &self,
        _operation_id: OperationId,
        _plugin_id: PluginId,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn list_publisher_trust(&self) -> RepositoryFuture<'_, Vec<PublisherTrust>> {
        plugin_unavailable()
    }

    fn trust_publisher(
        &self,
        _operation_id: OperationId,
        _request: TrustPublisherRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn revoke_publisher(
        &self,
        _operation_id: OperationId,
        _key_id: Sha256Digest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn get_community_plugin_policy(&self) -> RepositoryFuture<'_, CommunityPluginPolicy> {
        plugin_unavailable()
    }

    fn set_community_plugin_policy(
        &self,
        _operation_id: OperationId,
        _enabled: bool,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn list_plugin_grants(&self, _plugin_id: PluginId) -> RepositoryFuture<'_, Vec<PluginGrant>> {
        plugin_unavailable()
    }

    fn replace_plugin_grants(
        &self,
        _operation_id: OperationId,
        _request: ReplacePluginGrantsRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn revoke_plugin_grants(
        &self,
        _operation_id: OperationId,
        _request: RevokePluginGrantsRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn list_plugin_settings(
        &self,
        _plugin_id: PluginId,
    ) -> RepositoryFuture<'_, Vec<PluginSetting>> {
        plugin_unavailable()
    }

    fn set_plugin_setting(
        &self,
        _operation_id: OperationId,
        _request: SetPluginSettingRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn delete_plugin_setting(
        &self,
        _operation_id: OperationId,
        _request: DeletePluginSettingRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn list_plugin_kv(&self, _plugin_id: PluginId) -> RepositoryFuture<'_, Vec<PluginKvEntry>> {
        plugin_unavailable()
    }

    fn patch_plugin_kv(
        &self,
        _plugin_id: PluginId,
        _package_generation: u64,
        _activation_epoch: u64,
        _patch: PluginKvPatch,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, Vec<PluginKvEntry>> {
        plugin_unavailable()
    }

    fn get_plugin_cursor(&self, _plugin_id: PluginId) -> RepositoryFuture<'_, PluginEventCursor> {
        plugin_unavailable()
    }

    fn begin_plugin_resync(
        &self,
        _request: BeginPluginResyncRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginResyncSession> {
        plugin_unavailable()
    }

    fn list_plugin_resync_page(
        &self,
        _request: PluginResyncPageRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginResyncPage> {
        plugin_unavailable()
    }

    fn advance_plugin_cursor(
        &self,
        _request: AdvancePluginCursorRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginEventCursor> {
        plugin_unavailable()
    }

    fn reserve_plugin_invocation(
        &self,
        _request: ReservePluginInvocationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, ReservedPluginInvocation> {
        plugin_unavailable()
    }

    fn transition_plugin_invocation(
        &self,
        _request: TransitionPluginInvocationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginInvocation> {
        plugin_unavailable()
    }

    fn list_plugin_invocations(&self) -> RepositoryFuture<'_, Vec<PluginInvocation>> {
        plugin_unavailable()
    }

    fn complete_plugin_invocation(
        &self,
        _operation_id: OperationId,
        _plugin_id: PluginId,
        _package_generation: u64,
        _activation_epoch: u64,
    ) -> RepositoryFuture<'_, ()> {
        plugin_unavailable()
    }

    fn commit_plugin_invocation(
        &self,
        _request: CommitPluginInvocationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedPluginInvocation> {
        plugin_unavailable()
    }

    fn update_plugin_bookkeeping(
        &self,
        _update: PluginBookkeepingUpdate,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, InstalledPlugin> {
        plugin_unavailable()
    }
}

pub fn is_plugin_downgrade(candidate: &str, installed: &str) -> Result<bool, SdkError> {
    Ok(compare_versions(candidate, installed)? == Ordering::Less)
}
