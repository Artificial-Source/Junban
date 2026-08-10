//! Typed application/storage authority for normalized plugin persistence.
//!
//! This module deliberately contains no runtime host, transport, registry, or UI
//! wrappers. The SQLite owner implements [`PluginRepository`]; later runtime
//! waves consume this bounded port.

use std::{
    cmp::Ordering,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
};

use jiff::Timestamp;
use junban_domain::{OperationId, Project, ProjectId, Tag, TagId, Task, TaskDraft, TaskId};
use junban_plugin_sdk::{
    Capability, ComponentInspection, DependencyLock, GraphError, InvocationKind, OutcomeKind,
    Permission, PluginId, RuntimeManifest, RuntimeProfile, SdkError, SettingValue, Sha256Digest,
    compare_versions, inspect_component, inspect_component_reader, outcome_authority,
    parse_package, permission_set_hash, signer_key_id, verify_package, verify_package_reader,
    version_matches,
};
use serde::{Deserialize, Serialize};

use crate::{
    BulkAction, CommittedMutation, MarkPluginInvalidatingEventRequest,
    MarkPluginRetentionLossRequest, PluginOperatorRequestIdentity, ProjectDraft, ProjectPatch,
    RepositoryError, RepositoryFuture, TagDraft, TagPatch, TaskPatch, TemporalContext,
    VerifiedPluginCursorSkipRequest,
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
pub const PLUGIN_GRAPH_FENCE_ENTRIES_MAX: usize = 16;
pub const PLUGIN_FAILURE_BACKOFF_START_SECONDS: i64 = 30;
pub const PLUGIN_FAILURE_BACKOFF_MAX_SECONDS: i64 = 60 * 60;

/// One exact runtime generation selected by the parent supervisor. Selections
/// are accepted only as a strictly plugin-id-sorted, unique, nonempty list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginComponentSelection {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
}

/// Still-open, bounded authority for one verified component. The package file
/// handle is intentionally encapsulated: callers can seek and read only within
/// the verified component range and cannot recover a filesystem path.
pub struct OpenedPluginComponentSource {
    file: File,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    component_offset: u64,
    component_length: u64,
    component_sha256: Sha256Digest,
    runtime_profile: RuntimeProfile,
    import_export_fingerprint: Sha256Digest,
    permission_hash: Sha256Digest,
    grants: Vec<Permission>,
}

impl OpenedPluginComponentSource {
    /// Storage-only construction seam after the package path, open handle,
    /// package authority, persisted rows, trust and grants have all matched.
    #[doc(hidden)]
    #[allow(clippy::too_many_arguments)]
    pub fn from_verified_package_file(
        mut file: File,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        component_offset: u64,
        component_length: u64,
        component_sha256: Sha256Digest,
        runtime_profile: RuntimeProfile,
        import_export_fingerprint: Sha256Digest,
        permission_hash: Sha256Digest,
        grants: Vec<Permission>,
    ) -> io::Result<Self> {
        let component_end = component_offset
            .checked_add(component_length)
            .ok_or_else(|| io::Error::other("invalid plugin component authority"))?;
        if package_generation == 0
            || activation_epoch == 0
            || component_offset == 0
            || component_length == 0
            || component_length > junban_plugin_sdk::COMPONENT_BYTES_MAX as u64
            || file.metadata()?.len() != component_end
        {
            return Err(io::Error::other("invalid plugin component authority"));
        }
        file.seek(SeekFrom::Start(component_offset))?;
        Ok(Self {
            file,
            plugin_id,
            package_generation,
            activation_epoch,
            component_offset,
            component_length,
            component_sha256,
            runtime_profile,
            import_export_fingerprint,
            permission_hash,
            grants,
        })
    }

    #[must_use]
    pub fn plugin_id(&self) -> &PluginId {
        &self.plugin_id
    }

    #[must_use]
    pub const fn package_generation(&self) -> u64 {
        self.package_generation
    }

    #[must_use]
    pub const fn activation_epoch(&self) -> u64 {
        self.activation_epoch
    }

    #[must_use]
    pub const fn component_offset(&self) -> u64 {
        self.component_offset
    }

    #[must_use]
    pub const fn component_length(&self) -> u64 {
        self.component_length
    }

    #[must_use]
    pub fn component_sha256(&self) -> &Sha256Digest {
        &self.component_sha256
    }

    #[must_use]
    pub const fn runtime_profile(&self) -> RuntimeProfile {
        self.runtime_profile
    }

    #[must_use]
    pub fn import_export_fingerprint(&self) -> &Sha256Digest {
        &self.import_export_fingerprint
    }

    #[must_use]
    pub fn permission_hash(&self) -> &Sha256Digest {
        &self.permission_hash
    }

    #[must_use]
    pub fn grants(&self) -> &[Permission] {
        &self.grants
    }

    fn relative_position(&mut self) -> io::Result<u64> {
        self.file
            .stream_position()?
            .checked_sub(self.component_offset)
            .filter(|position| *position <= self.component_length)
            .ok_or_else(|| io::Error::other("invalid plugin component position"))
    }
}

impl Read for OpenedPluginComponentSource {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let remaining = self
            .component_length
            .checked_sub(self.relative_position()?)
            .ok_or_else(|| io::Error::other("invalid plugin component position"))?;
        let limit = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| io::Error::other("invalid plugin component length"))?;
        self.file.read(&mut buffer[..limit])
    }
}

impl Seek for OpenedPluginComponentSource {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let current = i128::from(self.relative_position()?);
        let length = i128::from(self.component_length);
        let target = match position {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => length + i128::from(offset),
            SeekFrom::Current(offset) => current + i128::from(offset),
        };
        if !(0..=length).contains(&target) {
            return Err(io::Error::other("invalid plugin component seek"));
        }
        let target =
            u64::try_from(target).map_err(|_| io::Error::other("invalid plugin component seek"))?;
        self.file.seek(SeekFrom::Start(
            self.component_offset
                .checked_add(target)
                .ok_or_else(|| io::Error::other("invalid plugin component seek"))?,
        ))?;
        Ok(target)
    }
}

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
        Self::from_verified(package.manifest, package.identities, publisher_public_key)
    }

    /// Inspect a bounded seekable JBP1 source without retaining package bytes.
    pub fn inspect_reader<R: Read + Seek>(
        reader: &mut R,
        package_len: u64,
    ) -> Result<Self, SdkError> {
        Self::inspect_reader_with_component(reader, package_len).map(|(package, _)| package)
    }

    /// Inspect a bounded seekable JBP1 source while retaining the exact
    /// import/export authority derived during that same verification pass.
    pub fn inspect_reader_with_component<R: Read + Seek>(
        reader: &mut R,
        package_len: u64,
    ) -> Result<(Self, ComponentInspection), SdkError> {
        let package = verify_package_reader(reader, package_len)?;
        let component =
            inspect_component_reader(reader, package.identities.component_size, &package.manifest)?;
        let authority = Self::from_verified(
            package.manifest,
            package.identities,
            package.publisher_public_key,
        )?;
        Ok((authority, component))
    }

    fn from_verified(
        manifest: RuntimeManifest,
        identities: junban_plugin_sdk::PackageIdentities,
        publisher_public_key: [u8; 32],
    ) -> Result<Self, SdkError> {
        if !version_matches(&manifest.junban_compatibility, env!("CARGO_PKG_VERSION"))? {
            return Err(SdkError::Manifest {
                field: "compatibility.junban",
            });
        }
        Ok(Self {
            plugin_id: PluginId::parse(manifest.id.clone())?,
            manifest,
            package_sha256: Sha256Digest::parse(identities.package_sha256)?,
            manifest_sha256: Sha256Digest::parse(identities.manifest_sha256)?,
            component_sha256: Sha256Digest::parse(identities.component_sha256)?,
            publisher_key_id: Sha256Digest::parse(identities.key_id)?,
            publisher_public_key,
            package_size: identities.package_size,
            component_size: identities.component_size,
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

#[derive(Debug)]
pub struct PluginPackageAdmission {
    staged: crate::StagedFile,
    package: PluginPackageAuthority,
}

impl PluginPackageAdmission {
    pub fn inspect(staged: crate::StagedFile) -> Result<Self, SdkError> {
        if staged.is_empty() || staged.len() > junban_plugin_sdk::PACKAGE_BYTES_MAX as u64 {
            return Err(SdkError::Length { field: "package" });
        }
        let mut file = std::fs::File::open(staged.path())
            .map_err(|_| SdkError::Truncated { format: "JBP1" })?;
        let metadata = file
            .metadata()
            .map_err(|_| SdkError::Truncated { format: "JBP1" })?;
        if !metadata.is_file() || metadata.len() != staged.len() {
            return Err(SdkError::Length { field: "package" });
        }
        let package = PluginPackageAuthority::inspect_reader(&mut file, staged.len())?;
        Ok(Self { staged, package })
    }

    #[must_use]
    pub const fn package(&self) -> &PluginPackageAuthority {
        &self.package
    }

    #[must_use]
    pub fn into_parts(self) -> (crate::StagedFile, PluginPackageAuthority) {
        (self.staged, self.package)
    }
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

/// Exact manifest contribution selected by one durable invocation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginManifestEntry {
    Command {
        command_id: PluginId,
    },
    Event {
        event_id: PluginId,
    },
    SurfaceAction {
        surface_id: PluginId,
        action_id: PluginId,
    },
    Resync,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginManifestEntryAuthority {
    pub entry: PluginManifestEntry,
    pub persisted_id: PluginId,
    pub required_capability: Option<Capability>,
}

#[derive(Clone, Copy)]
pub enum PluginManifestEntrySelector<'a> {
    Requested(&'a PluginManifestEntry),
    Persisted(&'a PluginId),
}

/// Resolve one exact requested or persisted manifest entry through the same
/// canonical authority. Surface actions are persisted as a domain-separated
/// digest of both local IDs, so duplicate action IDs on different surfaces
/// remain unambiguous without changing schema v7.
#[must_use]
pub fn plugin_manifest_entry_authority(
    manifest: &RuntimeManifest,
    hook: PluginHookKind,
    selector: PluginManifestEntrySelector<'_>,
) -> Option<PluginManifestEntryAuthority> {
    fn surface_action_id(surface_id: &str, action_id: &str) -> Option<PluginId> {
        let mut material = b"junban.plugin.surface-action-entry.v1\0".to_vec();
        for value in [surface_id, action_id] {
            material.extend_from_slice(&u32::try_from(value.len()).ok()?.to_be_bytes());
            material.extend_from_slice(value.as_bytes());
        }
        PluginId::parse(Sha256Digest::of(&material).into_string()).ok()
    }

    let mut candidates = Vec::new();
    match hook {
        PluginHookKind::InvokeCommand => {
            for command in &manifest.commands {
                let command_id = PluginId::parse(command.id.clone()).ok()?;
                candidates.push(PluginManifestEntryAuthority {
                    persisted_id: command_id.clone(),
                    entry: PluginManifestEntry::Command { command_id },
                    required_capability: Some(Capability::Commands),
                });
            }
        }
        PluginHookKind::HandleEvent => {
            for event in &manifest.subscriptions {
                let event_id = PluginId::parse(event.as_str()).ok()?;
                candidates.push(PluginManifestEntryAuthority {
                    persisted_id: event_id.clone(),
                    entry: PluginManifestEntry::Event { event_id },
                    required_capability: Some(Capability::EventsSubscribe),
                });
            }
        }
        PluginHookKind::HandleSurfaceAction => {
            for surface in &manifest.surfaces {
                let surface_id = PluginId::parse(surface.id.clone()).ok()?;
                let required_capability = Some(match surface.kind {
                    junban_plugin_sdk::SurfaceKind::View => Capability::UiView,
                    junban_plugin_sdk::SurfaceKind::Panel => Capability::UiPanel,
                    junban_plugin_sdk::SurfaceKind::Status => Capability::UiStatus,
                });
                for action in &surface.actions {
                    let action_id = PluginId::parse(action.clone()).ok()?;
                    candidates.push(PluginManifestEntryAuthority {
                        persisted_id: surface_action_id(surface_id.as_str(), action_id.as_str())?,
                        entry: PluginManifestEntry::SurfaceAction {
                            surface_id: surface_id.clone(),
                            action_id,
                        },
                        required_capability,
                    });
                }
            }
        }
        PluginHookKind::Resync => candidates.push(PluginManifestEntryAuthority {
            entry: PluginManifestEntry::Resync,
            persisted_id: PluginId::parse("resync").ok()?,
            required_capability: None,
        }),
    }
    let matches: Vec<_> = candidates
        .into_iter()
        .filter(|candidate| match selector {
            PluginManifestEntrySelector::Requested(requested) => candidate.entry == *requested,
            PluginManifestEntrySelector::Persisted(persisted) => {
                candidate.persisted_id == *persisted
            }
        })
        .collect();
    (matches.len() == 1).then(|| matches.into_iter().next().expect("one manifest entry"))
}

/// Derive the schema-v7 canonical persisted identity of one already-selected
/// manifest entry without requiring the plugin to remain installed.
#[must_use]
pub fn plugin_manifest_entry_persisted_id(entry: &PluginManifestEntry) -> Option<PluginId> {
    match entry {
        PluginManifestEntry::Command { command_id }
        | PluginManifestEntry::Event {
            event_id: command_id,
        } => Some(command_id.clone()),
        PluginManifestEntry::SurfaceAction {
            surface_id,
            action_id,
        } => {
            let mut material = b"junban.plugin.surface-action-entry.v1\0".to_vec();
            for value in [surface_id.as_str(), action_id.as_str()] {
                material.extend_from_slice(&u32::try_from(value.len()).ok()?.to_be_bytes());
                material.extend_from_slice(value.as_bytes());
            }
            PluginId::parse(Sha256Digest::of(&material).into_string()).ok()
        }
        PluginManifestEntry::Resync => PluginId::parse("resync").ok(),
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
    pub entry: PluginManifestEntry,
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
    pub entry: PluginManifestEntry,
    pub request_sha256: Sha256Digest,
    pub delivery_operation_id: OperationId,
    #[serde(skip)]
    pub resync_session: Option<PluginResyncSession>,
}

/// Slice 2D authorization wrapper. The unwrapped request remains temporarily
/// available to the pre-Slice-2D supervisor and must not be used by new delivery
/// code.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizedReservePluginInvocationRequest {
    pub request: ReservePluginInvocationRequest,
    pub delivery: crate::PluginInvocationDelivery,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReservedPluginInvocation {
    Reserved(PluginInvocation),
    InFlightReplay(PluginInvocation),
    TerminalReplay(Box<CommittedPluginInvocation>),
}

impl ReservedPluginInvocation {
    #[must_use]
    pub fn invocation(&self) -> Option<&PluginInvocation> {
        match self {
            Self::Reserved(invocation) | Self::InFlightReplay(invocation) => Some(invocation),
            Self::TerminalReplay(_) => None,
        }
    }

    #[must_use]
    pub fn terminal(&self) -> Option<&CommittedPluginInvocation> {
        match self {
            Self::TerminalReplay(committed) => Some(committed),
            Self::Reserved(_) | Self::InFlightReplay(_) => None,
        }
    }

    #[must_use]
    pub const fn replayed(&self) -> bool {
        !matches!(self, Self::Reserved(_))
    }
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
pub struct AuthorizedTransitionPluginInvocationRequest {
    pub request: TransitionPluginInvocationRequest,
    pub delivery: crate::PluginInvocationDelivery,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletePluginInvocationRequest {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub delivery: crate::PluginInvocationDelivery,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DuePluginRetryRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub expected_runtime_state: PluginRuntimeState,
    pub expected_next_retry_at: Timestamp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CompletePluginActivationRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginAttemptFailureCause {
    GuestTrap,
    Timeout,
    ResourceLimit,
    InvalidOutput,
    ActivationFailed,
    InternalError,
}

impl PluginAttemptFailureCause {
    #[must_use]
    pub const fn error_code(self) -> &'static str {
        match self {
            Self::GuestTrap => "guest_trap",
            Self::Timeout => "timeout",
            Self::ResourceLimit => "resource_limit",
            Self::InvalidOutput => "invalid_output",
            Self::ActivationFailed => "activation_failed",
            Self::InternalError => "internal_error",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RecordPluginAttemptFailureRequest {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub cause: PluginAttemptFailureCause,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginGraphFenceCause {
    CompileLoad,
    ChildFatal,
    SessionLost,
    DependencyFailed,
}

impl PluginGraphFenceCause {
    #[must_use]
    pub const fn error_code(self) -> &'static str {
        match self {
            Self::CompileLoad => "compile_load",
            Self::ChildFatal => "child_fatal",
            Self::SessionLost => "session_lost",
            Self::DependencyFailed => "dependency_failed",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginGraphFenceDisposition {
    Failing,
    LoadedSibling,
    SkippedDependent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PluginGraphFenceEntry {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub cause: PluginGraphFenceCause,
    pub disposition: PluginGraphFenceDisposition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PluginGraphFenceRequest {
    pub operation_id: OperationId,
    pub host_session_id: String,
    pub entries: Vec<PluginGraphFenceEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginGraphFenceResult {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub expected_activation_epoch: u64,
    pub new_activation_epoch: u64,
    pub prior_runtime_state: PluginRuntimeState,
    pub target_runtime_state: PluginRuntimeState,
    pub failure_count: u32,
    pub cause: PluginGraphFenceCause,
    pub desired_enabled: bool,
    pub disposition: PluginGraphFenceDisposition,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginGraphFenceOutcome {
    pub host_session_id: String,
    pub results: Vec<PluginGraphFenceResult>,
    pub mutation: CommittedMutation,
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

pub struct AuthorizedCommitPluginInvocationRequest {
    pub request: CommitPluginInvocationRequest,
    pub delivery: crate::PluginInvocationDelivery,
}

/// Transaction-local form of the first-party mutation repository. Storage
/// implements this over its current SQLite transaction; application plans never
/// receive a connection or storage-specific type.
pub trait ApplicationMutationUnitOfWork {
    fn create_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        draft: TaskDraft,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn patch_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        patch: TaskPatch,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn complete_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn uncomplete_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn cancel_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn reopen_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn delete_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn bulk_tasks(
        &mut self,
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: BulkAction,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn create_project(
        &mut self,
        operation_id: OperationId,
        project_id: ProjectId,
        draft: ProjectDraft,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn patch_project(
        &mut self,
        operation_id: OperationId,
        project_id: ProjectId,
        patch: ProjectPatch,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn delete_project(
        &mut self,
        operation_id: OperationId,
        project_id: ProjectId,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn create_tag(
        &mut self,
        operation_id: OperationId,
        tag_id: TagId,
        draft: TagDraft,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn patch_tag(
        &mut self,
        operation_id: OperationId,
        tag_id: TagId,
        patch: TagPatch,
    ) -> Result<CommittedMutation, RepositoryError>;
    fn delete_tag(
        &mut self,
        operation_id: OperationId,
        tag_id: TagId,
    ) -> Result<CommittedMutation, RepositoryError>;
}

type MutationPlan = Box<
    dyn FnOnce(&mut dyn ApplicationMutationUnitOfWork) -> Result<CommittedMutation, RepositoryError>
        + Send,
>;

pub struct PlannedPluginDomainMutation {
    required_capability: Capability,
    plan: MutationPlan,
}

impl PlannedPluginDomainMutation {
    #[must_use]
    pub const fn required_capability(&self) -> Capability {
        self.required_capability
    }

    pub fn execute(
        self,
        unit_of_work: &mut dyn ApplicationMutationUnitOfWork,
    ) -> Result<CommittedMutation, RepositoryError> {
        (self.plan)(unit_of_work)
    }
}

/// AppService-selected invocation commit authority passed to storage.
pub struct PlannedPluginInvocationCommit {
    pub invocation_operation_id: OperationId,
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub domain_mutation: Option<PlannedPluginDomainMutation>,
    pub kv_patch: Option<PluginKvPatch>,
    pub resync_kv: Option<PluginResyncKvCommit>,
    pub cursor: Option<AdvancePluginCursorRequest>,
    pub resync_session: Option<PluginResyncSession>,
}

pub struct AuthorizedPlannedPluginInvocationCommit {
    pub planned: PlannedPluginInvocationCommit,
    pub delivery: crate::PluginInvocationDelivery,
}

pub fn plan_authorized_plugin_invocation_commit(
    request: AuthorizedCommitPluginInvocationRequest,
) -> Result<AuthorizedPlannedPluginInvocationCommit, RepositoryError> {
    Ok(AuthorizedPlannedPluginInvocationCommit {
        planned: plan_plugin_invocation_commit(request.request)?,
        delivery: request.delivery,
    })
}

/// Select the exact first-party use case in the application layer. The selected
/// closure later executes inside storage's caller-owned transaction.
fn plan_plugin_invocation_commit(
    request: CommitPluginInvocationRequest,
) -> Result<PlannedPluginInvocationCommit, RepositoryError> {
    let CommitPluginInvocationRequest {
        invocation_operation_id,
        plugin_id,
        package_generation,
        activation_epoch,
        child_operation_id,
        domain_effect,
        kv_patch,
        resync_kv,
        cursor,
        resync_session,
    } = request;
    if domain_effect.is_some() != child_operation_id.is_some()
        || (domain_effect.is_some() && kv_patch.is_some())
        || child_operation_id == Some(invocation_operation_id)
    {
        return Err(RepositoryError::Conflict);
    }
    let domain_mutation = match (child_operation_id, domain_effect) {
        (Some(operation_id), Some(effect)) => {
            let required_capability = effect.required_capability();
            let plan: MutationPlan = match effect {
                PluginDomainEffect::CreateTask { task_id, draft } => {
                    Box::new(move |unit| unit.create_task(operation_id, task_id, draft))
                }
                PluginDomainEffect::PatchTask { task_id, patch } => {
                    Box::new(move |unit| unit.patch_task(operation_id, task_id, patch))
                }
                PluginDomainEffect::CompleteTask { task_id, temporal } => {
                    Box::new(move |unit| unit.complete_task(operation_id, task_id, temporal))
                }
                PluginDomainEffect::UncompleteTask { task_id, temporal } => {
                    Box::new(move |unit| unit.uncomplete_task(operation_id, task_id, temporal))
                }
                PluginDomainEffect::CancelTask { task_id } => {
                    Box::new(move |unit| unit.cancel_task(operation_id, task_id))
                }
                PluginDomainEffect::ReopenTask { task_id } => {
                    Box::new(move |unit| unit.reopen_task(operation_id, task_id))
                }
                PluginDomainEffect::DeleteTask { task_id } => {
                    Box::new(move |unit| unit.delete_task(operation_id, task_id))
                }
                PluginDomainEffect::BulkTasks {
                    task_ids,
                    action,
                    temporal,
                } => {
                    Box::new(move |unit| unit.bulk_tasks(operation_id, task_ids, action, temporal))
                }
                PluginDomainEffect::CreateProject { project_id, draft } => {
                    Box::new(move |unit| unit.create_project(operation_id, project_id, draft))
                }
                PluginDomainEffect::PatchProject { project_id, patch } => {
                    Box::new(move |unit| unit.patch_project(operation_id, project_id, patch))
                }
                PluginDomainEffect::DeleteProject { project_id } => {
                    Box::new(move |unit| unit.delete_project(operation_id, project_id))
                }
                PluginDomainEffect::CreateTag { tag_id, draft } => {
                    Box::new(move |unit| unit.create_tag(operation_id, tag_id, draft))
                }
                PluginDomainEffect::PatchTag { tag_id, patch } => {
                    Box::new(move |unit| unit.patch_tag(operation_id, tag_id, patch))
                }
                PluginDomainEffect::DeleteTag { tag_id } => {
                    Box::new(move |unit| unit.delete_tag(operation_id, tag_id))
                }
            };
            Some(PlannedPluginDomainMutation {
                required_capability,
                plan,
            })
        }
        (None, None) => None,
        _ => unreachable!("operation and effect pairing validated"),
    };
    Ok(PlannedPluginInvocationCommit {
        invocation_operation_id,
        plugin_id,
        package_generation,
        activation_epoch,
        domain_mutation,
        kv_patch,
        resync_kv,
        cursor,
        resync_session,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginInvocationTerminalKind {
    ReadOnly,
    Http,
    Kv,
    DomainEffect,
}

/// Closed storage-boundary classification for an authorized guest effect that
/// was rejected without committing any first-party mutation material.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginGuestEffectRejection {
    NotFound,
    Conflict,
    IdempotencyMismatch,
    OperationTooLarge,
    Validation,
}

impl PluginGuestEffectRejection {
    #[must_use]
    pub const fn from_repository_error(error: &RepositoryError) -> Option<Self> {
        match error {
            RepositoryError::NotFound => Some(Self::NotFound),
            RepositoryError::Conflict => Some(Self::Conflict),
            RepositoryError::IdempotencyMismatch => Some(Self::IdempotencyMismatch),
            RepositoryError::OperationTooLarge => Some(Self::OperationTooLarge),
            RepositoryError::Validation(_) => Some(Self::Validation),
            RepositoryError::Storage(_) | RepositoryError::CatastrophicRestore { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommittedPluginInvocation {
    pub terminal_kind: PluginInvocationTerminalKind,
    pub mutation: Option<CommittedMutation>,
    pub cursor: Option<PluginEventCursor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejection: Option<PluginGuestEffectRejection>,
    /// Set only when reservation explicitly replays a terminal receipt.
    #[serde(skip, default)]
    pub replayed: bool,
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
    /// Verify and durably publish one cleanup-owning private staged JBP1 package.
    /// The transport must retain its staged-artifact permit until this future
    /// completes; the repository owns cleanup even if the caller cancels.
    fn publish_plugin_package(
        &self,
        _staged: crate::StagedFile,
    ) -> RepositoryFuture<'_, PluginPackageAuthority> {
        plugin_unavailable()
    }

    /// Publish and admit one cleanup-owning staged package in one worker
    /// command, preventing cancellation or failed metadata admission from
    /// abandoning staged or unreferenced immutable files.
    fn install_plugin_admission(
        &self,
        _operation_id: OperationId,
        _admission: PluginPackageAdmission,
        _request: InstallPluginRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginMutationOutcome> {
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

    /// Open one exact selected runtime graph from a single durable snapshot.
    /// Successful values are dependency-ordered and retain only bounded
    /// component readers plus runtime authority, never package paths or bytes.
    fn open_plugin_component_sources(
        &self,
        _selected: Vec<PluginComponentSelection>,
    ) -> RepositoryFuture<'_, Vec<OpenedPluginComponentSource>> {
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

    fn get_plugin_cursor(&self, _plugin_id: PluginId) -> RepositoryFuture<'_, PluginEventCursor> {
        plugin_unavailable()
    }

    fn open_plugin_resync_session(
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

    fn finalize_plugin_resync(
        &self,
        _request: crate::FinalizePluginResyncRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, crate::FinalizePluginResyncOutcome> {
        plugin_unavailable()
    }

    /// Persist SQLite-proven retention loss after trusted composition has
    /// matched the request's raw host session to its current runtime actor.
    fn mark_plugin_retention_loss(
        &self,
        _request: MarkPluginRetentionLossRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginEventCursor> {
        plugin_unavailable()
    }

    /// Persist an exact live-manifest invalidating-event transition after
    /// trusted composition matched the raw host session to its current actor.
    fn mark_plugin_invalidating_event(
        &self,
        _request: MarkPluginInvalidatingEventRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginEventCursor> {
        plugin_unavailable()
    }

    fn verified_skip_plugin_cursor(
        &self,
        _request: VerifiedPluginCursorSkipRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginEventCursor> {
        plugin_unavailable()
    }

    fn replay_completed_plugin_operator(
        &self,
        _identity: PluginOperatorRequestIdentity,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, Option<CommittedPluginInvocation>> {
        plugin_unavailable()
    }

    fn reserve_authorized_plugin_invocation(
        &self,
        _request: AuthorizedReservePluginInvocationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, ReservedPluginInvocation> {
        plugin_unavailable()
    }

    fn transition_authorized_plugin_invocation(
        &self,
        _request: AuthorizedTransitionPluginInvocationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginInvocation> {
        plugin_unavailable()
    }

    fn list_plugin_invocations(&self) -> RepositoryFuture<'_, Vec<PluginInvocation>> {
        plugin_unavailable()
    }

    fn complete_authorized_plugin_invocation(
        &self,
        _request: CompletePluginInvocationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedPluginInvocation> {
        plugin_unavailable()
    }

    fn commit_authorized_plugin_invocation(
        &self,
        _request: AuthorizedPlannedPluginInvocationCommit,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedPluginInvocation> {
        plugin_unavailable()
    }

    fn retry_due_plugin(
        &self,
        _operation_id: OperationId,
        _request: DuePluginRetryRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn complete_plugin_activation(
        &self,
        _operation_id: OperationId,
        _request: CompletePluginActivationRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn record_plugin_attempt_failure(
        &self,
        _operation_id: OperationId,
        _request: RecordPluginAttemptFailureRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation> {
        plugin_unavailable()
    }

    fn fence_plugin_graph(
        &self,
        _request: PluginGraphFenceRequest,
        _now: Timestamp,
    ) -> RepositoryFuture<'_, PluginGraphFenceOutcome> {
        plugin_unavailable()
    }
}

pub fn is_plugin_downgrade(candidate: &str, installed: &str) -> Result<bool, SdkError> {
    Ok(compare_versions(candidate, installed)? == Ordering::Less)
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write as _};

    use super::*;
    use junban_domain::{EntityName, HexColor, ProjectView, SortOrder, TagName, TaskTitle};

    #[derive(Default)]
    struct RecordingUnitOfWork {
        called: Option<&'static str>,
    }

    impl RecordingUnitOfWork {
        fn record(&mut self, name: &'static str) -> Result<CommittedMutation, RepositoryError> {
            self.called = Some(name);
            Err(RepositoryError::Conflict)
        }
    }

    impl ApplicationMutationUnitOfWork for RecordingUnitOfWork {
        fn create_task(
            &mut self,
            _: OperationId,
            _: TaskId,
            _: TaskDraft,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("create_task")
        }
        fn patch_task(
            &mut self,
            _: OperationId,
            _: TaskId,
            _: TaskPatch,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("patch_task")
        }
        fn complete_task(
            &mut self,
            _: OperationId,
            _: TaskId,
            _: TemporalContext,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("complete_task")
        }
        fn uncomplete_task(
            &mut self,
            _: OperationId,
            _: TaskId,
            _: TemporalContext,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("uncomplete_task")
        }
        fn cancel_task(
            &mut self,
            _: OperationId,
            _: TaskId,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("cancel_task")
        }
        fn reopen_task(
            &mut self,
            _: OperationId,
            _: TaskId,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("reopen_task")
        }
        fn delete_task(
            &mut self,
            _: OperationId,
            _: TaskId,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("delete_task")
        }
        fn bulk_tasks(
            &mut self,
            _: OperationId,
            _: Vec<TaskId>,
            _: BulkAction,
            _: TemporalContext,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("bulk_tasks")
        }
        fn create_project(
            &mut self,
            _: OperationId,
            _: ProjectId,
            _: ProjectDraft,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("create_project")
        }
        fn patch_project(
            &mut self,
            _: OperationId,
            _: ProjectId,
            _: ProjectPatch,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("patch_project")
        }
        fn delete_project(
            &mut self,
            _: OperationId,
            _: ProjectId,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("delete_project")
        }
        fn create_tag(
            &mut self,
            _: OperationId,
            _: TagId,
            _: TagDraft,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("create_tag")
        }
        fn patch_tag(
            &mut self,
            _: OperationId,
            _: TagId,
            _: TagPatch,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("patch_tag")
        }
        fn delete_tag(
            &mut self,
            _: OperationId,
            _: TagId,
        ) -> Result<CommittedMutation, RepositoryError> {
            self.record("delete_tag")
        }
    }

    #[test]
    fn app_planner_selects_every_supported_first_party_mutation() {
        let task_id = TaskId::new();
        let project_id = ProjectId::new();
        let tag_id = TagId::new();
        let temporal = TemporalContext::sample_now();
        let project = ProjectDraft {
            name: EntityName::new("Project").unwrap(),
            color: HexColor::new("#112233").unwrap(),
            icon: None,
            parent_id: None,
            favorite: false,
            archived: false,
            view: ProjectView::default(),
            sort_order: SortOrder::default(),
        };
        let tag = TagDraft {
            name: TagName::new("tag").unwrap(),
            color: HexColor::new("#445566").unwrap(),
        };
        let effects = vec![
            (
                "create_task",
                PluginDomainEffect::CreateTask {
                    task_id,
                    draft: TaskDraft::new(TaskTitle::new("Task").unwrap()),
                },
            ),
            (
                "patch_task",
                PluginDomainEffect::PatchTask {
                    task_id,
                    patch: TaskPatch::default(),
                },
            ),
            (
                "complete_task",
                PluginDomainEffect::CompleteTask {
                    task_id,
                    temporal: temporal.clone(),
                },
            ),
            (
                "uncomplete_task",
                PluginDomainEffect::UncompleteTask {
                    task_id,
                    temporal: temporal.clone(),
                },
            ),
            ("cancel_task", PluginDomainEffect::CancelTask { task_id }),
            ("reopen_task", PluginDomainEffect::ReopenTask { task_id }),
            ("delete_task", PluginDomainEffect::DeleteTask { task_id }),
            (
                "bulk_tasks",
                PluginDomainEffect::BulkTasks {
                    task_ids: vec![task_id],
                    action: BulkAction::Cancel,
                    temporal,
                },
            ),
            (
                "create_project",
                PluginDomainEffect::CreateProject {
                    project_id,
                    draft: project,
                },
            ),
            (
                "patch_project",
                PluginDomainEffect::PatchProject {
                    project_id,
                    patch: ProjectPatch::default(),
                },
            ),
            (
                "delete_project",
                PluginDomainEffect::DeleteProject { project_id },
            ),
            (
                "create_tag",
                PluginDomainEffect::CreateTag { tag_id, draft: tag },
            ),
            (
                "patch_tag",
                PluginDomainEffect::PatchTag {
                    tag_id,
                    patch: TagPatch::default(),
                },
            ),
            ("delete_tag", PluginDomainEffect::DeleteTag { tag_id }),
        ];
        for (expected, effect) in effects {
            let planned = plan_plugin_invocation_commit(CommitPluginInvocationRequest {
                invocation_operation_id: OperationId::new(),
                plugin_id: PluginId::parse("planner-test").unwrap(),
                package_generation: 1,
                activation_epoch: 1,
                child_operation_id: Some(OperationId::new()),
                domain_effect: Some(effect),
                kv_patch: None,
                resync_kv: None,
                cursor: None,
                resync_session: None,
            })
            .unwrap();
            let mut unit = RecordingUnitOfWork::default();
            assert_eq!(
                planned
                    .domain_mutation
                    .unwrap()
                    .execute(&mut unit)
                    .unwrap_err(),
                RepositoryError::Conflict
            );
            assert_eq!(unit.called, Some(expected));
        }

        let operation_id = OperationId::new();
        assert!(matches!(
            plan_plugin_invocation_commit(CommitPluginInvocationRequest {
                invocation_operation_id: operation_id,
                plugin_id: PluginId::parse("planner-test").unwrap(),
                package_generation: 1,
                activation_epoch: 1,
                child_operation_id: Some(operation_id),
                domain_effect: Some(PluginDomainEffect::DeleteTask { task_id }),
                kv_patch: None,
                resync_kv: None,
                cursor: None,
                resync_session: None,
            }),
            Err(RepositoryError::Conflict)
        ));
    }

    #[test]
    fn opened_component_source_exposes_only_its_bounded_component_range() {
        let path =
            std::env::temp_dir().join(format!("junban-opened-component-{}", OperationId::new()));
        let mut file = File::create(&path).unwrap();
        file.write_all(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).unwrap();
        file.sync_all().unwrap();
        drop(file);
        let file = File::open(&path).unwrap();
        let digest = Sha256Digest::of(&[3, 4, 5, 6, 7, 8, 9]);
        let mut source = OpenedPluginComponentSource::from_verified_package_file(
            file,
            PluginId::parse("bounded-reader").unwrap(),
            1,
            1,
            3,
            7,
            digest,
            RuntimeProfile::Rust,
            Sha256Digest::of(b"imports"),
            Sha256Digest::of(b"permissions"),
            Vec::new(),
        )
        .unwrap();
        fs::remove_file(path).unwrap();

        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, [3, 4, 5, 6, 7, 8, 9]);
        assert_eq!(source.seek(SeekFrom::Start(0)).unwrap(), 0);
        assert!(source.seek(SeekFrom::Current(-1)).is_err());
        let mut first = [0_u8; 1];
        source.read_exact(&mut first).unwrap();
        assert_eq!(first, [3]);
    }

    #[test]
    fn lifecycle_failure_causes_have_closed_stable_codes() {
        assert_eq!(
            [
                PluginAttemptFailureCause::GuestTrap.error_code(),
                PluginAttemptFailureCause::Timeout.error_code(),
                PluginAttemptFailureCause::ResourceLimit.error_code(),
                PluginAttemptFailureCause::InvalidOutput.error_code(),
                PluginAttemptFailureCause::ActivationFailed.error_code(),
                PluginAttemptFailureCause::InternalError.error_code(),
            ],
            [
                "guest_trap",
                "timeout",
                "resource_limit",
                "invalid_output",
                "activation_failed",
                "internal_error",
            ]
        );
        assert_eq!(
            [
                PluginGraphFenceCause::CompileLoad.error_code(),
                PluginGraphFenceCause::ChildFatal.error_code(),
                PluginGraphFenceCause::SessionLost.error_code(),
                PluginGraphFenceCause::DependencyFailed.error_code(),
            ],
            [
                "compile_load",
                "child_fatal",
                "session_lost",
                "dependency_failed",
            ]
        );
    }
}
