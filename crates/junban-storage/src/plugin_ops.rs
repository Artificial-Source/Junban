//! Normalized plugin persistence operations on the single SQLite owner.

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    fmt::Write as _,
    rc::Rc,
};

use jiff::{Timestamp, ToSpan};
use junban_app::{
    AdvancePluginCursorRequest, AffectedIds, ApplicationMutationUnitOfWork,
    AuthorizedPlannedPluginInvocationCommit, AuthorizedReservePluginInvocationRequest,
    AuthorizedTransitionPluginInvocationRequest, BeginPluginResyncRequest, CommittedEvent,
    CommittedMutation, CommittedPluginInvocation, CommunityPluginPolicy,
    CompletePluginActivationRequest, CompletePluginInvocationRequest, DeletePluginSettingRequest,
    DuePluginRetryRequest, EVENT_RETAIN_MAX_COUNT, EventType, FinalizePluginResyncOutcome,
    FinalizePluginResyncRequest, InstallPluginRequest, InstalledPlugin, InstalledPluginProfile,
    MarkPluginInvalidatingEventRequest, MarkPluginRetentionLossRequest,
    OpenedPluginComponentSource, PLUGIN_DEPENDENTS_MAX, PLUGIN_FAILURE_BACKOFF_MAX_SECONDS,
    PLUGIN_FAILURE_BACKOFF_START_SECONDS, PLUGIN_GRAPH_FENCE_ENTRIES_MAX,
    PLUGIN_INVOCATION_MATERIAL_BYTES_MAX, PLUGIN_INVOCATION_MATERIAL_PER_PLUGIN_BYTES_MAX,
    PLUGIN_INVOCATION_RETENTION_DAYS, PLUGIN_INVOCATIONS_MAX, PLUGIN_INVOCATIONS_PER_PLUGIN_MAX,
    PLUGIN_KV_BYTES_MAX, PLUGIN_KV_KEYS_MAX, PLUGIN_KV_VALUE_BYTES_MAX,
    PLUGIN_RESYNC_PAGE_BYTES_MAX, PLUGIN_RESYNC_PAGE_ITEMS_MAX, PLUGIN_SETTINGS_BYTES_MAX,
    PLUGIN_SETTINGS_KEYS_MAX, PLUGINS_ENABLED_MAX, PLUGINS_INSTALLED_MAX,
    PlannedPluginInvocationCommit, PluginComponentSelection, PluginCursorPosition,
    PluginDeliveryMode, PluginEventCursor, PluginGrant, PluginGraphFenceCause,
    PluginGraphFenceDisposition, PluginGraphFenceOutcome, PluginGraphFenceRequest,
    PluginGraphFenceResult, PluginGraphRejection, PluginGuestEffectRejection, PluginHookKind,
    PluginInstallSource, PluginInvocation, PluginInvocationDelivery, PluginInvocationDeliveryCheck,
    PluginInvocationState, PluginInvocationTerminalKind, PluginKvEntry, PluginKvPatch,
    PluginManifestEntry, PluginManifestEntrySelector, PluginMutationOutcome,
    PluginOperatorRequestIdentity, PluginPackageAdmission, PluginPackageReconciliation,
    PluginResyncEvent, PluginResyncKvCommit, PluginResyncPage, PluginResyncPageRequest,
    PluginResyncSession, PluginRetainedEventClassification, PluginRuntimeState, PluginSetting,
    PluginSnapshotItem, PluginSnapshotKind, PublisherTrust, PublisherTrustStatus,
    RecordPluginAttemptFailureRequest, ReplacePluginGrantsRequest, RepositoryError,
    ReservePluginInvocationRequest, ReservedPluginInvocation, ResourceRef, ResourceSnapshot,
    ResyncScope, RevokePluginGrantsRequest, SetPluginSettingRequest,
    TransitionPluginInvocationRequest, TrustPublisherRequest, VerifiedPluginCursorSkipRequest,
    classify_plugin_resync_event, convert_active_plugin_event, plugin_committed_event_content_hash,
    plugin_invalidating_event_request_digest, plugin_invocation_request_hash,
    plugin_manifest_entry_authority, plugin_resync_request_hash,
    plugin_retained_event_payload_hash, plugin_retention_loss_request_digest,
};
use junban_domain::{OperationId, ProjectId, TagId, TaskId};
use junban_plugin_sdk::{
    Capability, DependencyLock, EventKind, GraphError, InstalledPackage, Permission,
    PermissionScope, PluginId, RuntimeManifest, SettingValue, Sha256Digest, compare_versions,
    permission_set_hash, scope_hash, validate_dependency_graph, validate_dependency_locks,
    validate_permission_grants, version_matches,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    catalog_ops,
    package_store::PluginPackageStore,
    rows::{load_project, load_tag, load_task, revision_to_i64, storage_error},
    task_ops,
    tx::{
        MutationEffect, RECEIPT_MATERIAL_MAX_BYTES, canonical_json, cleanup_expired_receipts,
        mutate, mutate_in_transaction, prune_retained_events, read_receipt_response,
        write_receipt_response_in_transaction,
    },
};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum OperatorRequest<'a> {
    Install {
        request: &'a InstallPluginRequest,
    },
    Uninstall {
        plugin_id: &'a PluginId,
    },
    SetDesiredEnabled {
        plugin_id: &'a PluginId,
        enabled: bool,
    },
    Retry {
        plugin_id: &'a PluginId,
    },
    TrustPublisher {
        request: &'a TrustPublisherRequest,
    },
    RevokePublisher {
        key_id: &'a Sha256Digest,
    },
    SetCommunityPolicy {
        enabled: bool,
    },
    ReplaceGrants {
        request: &'a ReplacePluginGrantsRequest,
    },
    RevokeGrants {
        request: &'a RevokePluginGrantsRequest,
    },
    SetSetting {
        request: &'a SetPluginSettingRequest,
    },
    DeleteSetting {
        request: &'a DeletePluginSettingRequest,
    },
}

fn parse_u64(value: i64, field: &'static str) -> Result<u64, RepositoryError> {
    u64::try_from(value).map_err(|_| RepositoryError::Storage(format!("invalid plugin {field}")))
}

fn parse_u32(value: i64, field: &'static str) -> Result<u32, RepositoryError> {
    u32::try_from(value).map_err(|_| RepositoryError::Storage(format!("invalid plugin {field}")))
}

fn as_i64(value: u64, field: &'static str) -> Result<i64, RepositoryError> {
    i64::try_from(value).map_err(|_| RepositoryError::Storage(format!("plugin {field} overflow")))
}

fn parse_timestamp(value: &str, field: &'static str) -> Result<Timestamp, RepositoryError> {
    value
        .parse()
        .map_err(|_| RepositoryError::Storage(format!("invalid plugin {field}")))
}

fn runtime_state(value: &str) -> Result<PluginRuntimeState, RepositoryError> {
    match value {
        "disabled" => Ok(PluginRuntimeState::Disabled),
        "starting" => Ok(PluginRuntimeState::Starting),
        "active" => Ok(PluginRuntimeState::Active),
        "degraded" => Ok(PluginRuntimeState::Degraded),
        "failed" => Ok(PluginRuntimeState::Failed),
        "suspended" => Ok(PluginRuntimeState::Suspended),
        "reverify_required" => Ok(PluginRuntimeState::ReverifyRequired),
        _ => Err(RepositoryError::Storage(
            "invalid plugin runtime state".to_owned(),
        )),
    }
}

fn canonical_manifest(raw: &str) -> Result<RuntimeManifest, RepositoryError> {
    RuntimeManifest::parse_canonical(raw.as_bytes()).map_err(storage_error)
}

fn load_installed_plugin(
    connection: &Connection,
    plugin_id: &PluginId,
) -> Result<InstalledPlugin, RepositoryError> {
    connection
        .query_row(
            "SELECT manifest_json, version, package_sha256, component_sha256,
                    publisher_key_id, package_generation, activation_epoch,
                    permission_hash, compatibility, desired_enabled, runtime_state,
                    failure_count, last_error_code, next_retry_at, installed_at, updated_at
             FROM plugins WHERE plugin_id = ?1",
            [plugin_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::NotFound)
        .and_then(
            |(
                manifest_json,
                version,
                package_sha256,
                component_sha256,
                publisher_key_id,
                package_generation,
                activation_epoch,
                permission_hash,
                compatibility,
                desired_enabled,
                state,
                failure_count,
                last_error_code,
                next_retry_at,
                installed_at,
                updated_at,
            )| {
                let manifest = canonical_manifest(&manifest_json)?;
                if last_error_code
                    .as_deref()
                    .is_some_and(|code| !crate::plugin_validation::valid_error_code(code))
                {
                    return Err(RepositoryError::Storage(
                        "invalid plugin failure code".to_owned(),
                    ));
                }
                let requested_hash = permission_set_hash(&manifest.permissions)
                    .map(Sha256Digest::from_bytes)
                    .map_err(storage_error)?;
                if manifest.id != plugin_id.as_str()
                    || manifest.version != version
                    || manifest.component_sha256 != component_sha256
                    || manifest.publisher.key_id != publisher_key_id
                    || manifest.junban_compatibility != compatibility
                    || requested_hash.as_str() != permission_hash
                    || !matches!(desired_enabled, 0 | 1)
                {
                    return Err(RepositoryError::Storage(
                        "plugin manifest authority mismatch".to_owned(),
                    ));
                }
                let mut granted_capabilities = Vec::new();
                let mut statement = connection
                    .prepare(
                        "SELECT DISTINCT capability FROM plugin_grants
                         WHERE plugin_id = ?1 ORDER BY capability",
                    )
                    .map_err(storage_error)?;
                let capabilities = statement
                    .query_map([plugin_id.as_str()], |row| row.get::<_, String>(0))
                    .map_err(storage_error)?;
                for capability in capabilities {
                    granted_capabilities.push(
                        serde_json::from_str::<Capability>(&format!(
                            "\"{}\"",
                            capability.map_err(storage_error)?
                        ))
                        .map_err(storage_error)?,
                    );
                }
                granted_capabilities.sort_unstable();
                let active_dependency_count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*)
                         FROM plugin_dependency_locks AS lock
                         JOIN plugins AS dependency ON dependency.plugin_id = lock.dependency_id
                         WHERE lock.plugin_id = ?1
                           AND dependency.desired_enabled = 1
                           AND dependency.runtime_state IN ('active', 'degraded')",
                        [plugin_id.as_str()],
                        |row| row.get(0),
                    )
                    .map_err(storage_error)?;
                let dependencies_satisfied = usize::try_from(active_dependency_count)
                    .is_ok_and(|count| count == manifest.dependencies.len());
                Ok(InstalledPlugin {
                    plugin_id: plugin_id.clone(),
                    manifest,
                    version,
                    package_sha256: Sha256Digest::parse(package_sha256).map_err(storage_error)?,
                    component_sha256: Sha256Digest::parse(component_sha256)
                        .map_err(storage_error)?,
                    publisher_key_id: Sha256Digest::parse(publisher_key_id)
                        .map_err(storage_error)?,
                    package_generation: parse_u64(package_generation, "package generation")?,
                    activation_epoch: parse_u64(activation_epoch, "activation epoch")?,
                    desired_enabled: desired_enabled == 1,
                    runtime_state: runtime_state(&state)?,
                    granted_capabilities,
                    dependencies_satisfied,
                    failure_count: parse_u32(failure_count, "failure count")?,
                    last_error_code,
                    next_retry_at: next_retry_at
                        .as_deref()
                        .map(|value| parse_timestamp(value, "retry timestamp"))
                        .transpose()?,
                    installed_at: parse_timestamp(&installed_at, "installed timestamp")?,
                    updated_at: parse_timestamp(&updated_at, "updated timestamp")?,
                })
            },
        )
}

fn load_plugins(connection: &Connection) -> Result<Vec<InstalledPlugin>, RepositoryError> {
    let mut statement = connection
        .prepare("SELECT plugin_id FROM plugins ORDER BY plugin_id")
        .map_err(storage_error)?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    let mut plugins = Vec::new();
    for id in ids {
        if plugins.len() == PLUGINS_INSTALLED_MAX {
            return Err(RepositoryError::Storage(
                "installed plugin bound exceeded".to_owned(),
            ));
        }
        let id = PluginId::parse(id.map_err(storage_error)?).map_err(storage_error)?;
        plugins.push(load_installed_plugin(connection, &id)?);
    }
    Ok(plugins)
}

fn sdk_packages(plugins: &[InstalledPlugin]) -> Vec<InstalledPackage<'_>> {
    plugins
        .iter()
        .map(|plugin| InstalledPackage {
            manifest: &plugin.manifest,
            package_generation: plugin.package_generation,
            package_sha256: plugin.package_sha256.as_str(),
        })
        .collect()
}

fn expected_locks(plugins: &[InstalledPlugin]) -> Result<Vec<DependencyLock>, RepositoryError> {
    let by_id: BTreeMap<&str, &InstalledPlugin> = plugins
        .iter()
        .map(|plugin| (plugin.plugin_id.as_str(), plugin))
        .collect();
    let mut locks = Vec::new();
    for plugin in plugins {
        for dependency in &plugin.manifest.dependencies {
            let resolved = by_id
                .get(dependency.id.as_str())
                .ok_or(RepositoryError::Conflict)?;
            locks.push(DependencyLock {
                plugin_id: plugin.plugin_id.to_string(),
                dependency_id: resolved.plugin_id.to_string(),
                version_requirement: dependency.requirement.clone(),
                resolved_version: resolved.version.clone(),
                dependency_package_generation: resolved.package_generation,
                dependency_package_sha256: resolved.package_sha256.to_string(),
            });
        }
    }
    locks.sort_by(|left, right| {
        (&left.plugin_id, &left.dependency_id).cmp(&(&right.plugin_id, &right.dependency_id))
    });
    validate_dependency_locks(&sdk_packages(plugins), &locks).map_err(storage_error)?;
    Ok(locks)
}

fn load_persisted_locks(connection: &Connection) -> Result<Vec<DependencyLock>, RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, dependency_id, version_requirement, resolved_version,
                    dependency_package_generation, dependency_package_sha256
             FROM plugin_dependency_locks ORDER BY plugin_id, dependency_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(storage_error)?;
    let mut locks = Vec::new();
    for row in rows {
        let (plugin_id, dependency_id, requirement, version, generation, digest) =
            row.map_err(storage_error)?;
        locks.push(DependencyLock {
            plugin_id,
            dependency_id,
            version_requirement: requirement,
            resolved_version: version,
            dependency_package_generation: parse_u64(generation, "dependency generation")?,
            dependency_package_sha256: digest,
        });
    }
    Ok(locks)
}

fn validate_current_graph(
    connection: &Connection,
    plugins: &[InstalledPlugin],
) -> Result<Vec<PluginId>, RepositoryError> {
    let graph = validate_dependency_graph(&sdk_packages(plugins)).map_err(storage_error)?;
    let locks = load_persisted_locks(connection)?;
    validate_dependency_locks(&sdk_packages(plugins), &locks).map_err(storage_error)?;
    if plugins
        .iter()
        .filter(|plugin| {
            plugin.desired_enabled && plugin.runtime_state == PluginRuntimeState::Active
        })
        .any(|plugin| {
            plugin.manifest.dependencies.iter().any(|dependency| {
                plugins
                    .iter()
                    .find(|candidate| candidate.plugin_id.as_str() == dependency.id)
                    .is_none_or(|dependency| !dependency.desired_enabled)
            })
        })
    {
        return Err(RepositoryError::Storage(
            "invalid plugin dependency lifecycle authority".to_owned(),
        ));
    }
    let revoked_enabled: bool = connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM plugins AS p
                JOIN plugin_publisher_trust AS trust ON trust.key_id = p.publisher_key_id
                WHERE p.desired_enabled = 1 AND trust.status = 'revoked'
             )",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if revoked_enabled {
        return Err(RepositoryError::Storage(
            "invalid plugin publisher activation authority".to_owned(),
        ));
    }
    graph
        .activation_order
        .into_iter()
        .map(|id| PluginId::parse(id).map_err(storage_error))
        .collect()
}

pub(crate) fn get_installed_plugin_profile(
    connection: &Connection,
) -> Result<InstalledPluginProfile, RepositoryError> {
    let plugins = load_plugins(connection)?;
    let activation_order = validate_current_graph(connection, &plugins)?;
    Ok(InstalledPluginProfile {
        plugins,
        activation_order,
        community_policy: get_community_plugin_policy(connection)?,
    })
}

pub(crate) fn get_installed_plugin(
    connection: &Connection,
    plugin_id: PluginId,
) -> Result<InstalledPlugin, RepositoryError> {
    load_installed_plugin(connection, &plugin_id)
}

fn persisted_plugin_permission_hash(
    connection: &Connection,
    plugin_id: &PluginId,
) -> Result<Sha256Digest, RepositoryError> {
    let value: String = connection
        .query_row(
            "SELECT permission_hash FROM plugins WHERE plugin_id = ?1",
            [plugin_id.as_str()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    Sha256Digest::parse(value).map_err(storage_error)
}

fn active_publisher_key(
    connection: &Connection,
    key_id: &Sha256Digest,
) -> Result<[u8; 32], RepositoryError> {
    let public_key = connection
        .query_row(
            "SELECT public_key FROM plugin_publisher_trust
             WHERE key_id = ?1 AND status = 'active'",
            [key_id.as_str()],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::Conflict)?;
    public_key
        .try_into()
        .map_err(|_| RepositoryError::Storage("invalid publisher key authority".to_owned()))
}

/// Validate one exact selected graph and retain the same strict handles used to
/// inspect its immutable packages. This read performs no revision, event,
/// receipt, health or desired-state mutation.
pub(crate) fn open_plugin_component_sources(
    connection: &mut Connection,
    store: &PluginPackageStore,
    selected: Vec<PluginComponentSelection>,
) -> Result<Vec<OpenedPluginComponentSource>, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(storage_error)?;
    crate::plugin_validation::validate_plugin_authority(&transaction)?;
    let profile = get_installed_plugin_profile(&transaction)?;

    if selected.is_empty() {
        return Err(RepositoryError::Conflict);
    }
    if selected.len() > PLUGINS_ENABLED_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    if selected
        .windows(2)
        .any(|pair| pair[0].plugin_id >= pair[1].plugin_id)
    {
        return Err(RepositoryError::Conflict);
    }

    let plugins_by_id: BTreeMap<&str, &InstalledPlugin> = profile
        .plugins
        .iter()
        .map(|plugin| (plugin.plugin_id.as_str(), plugin))
        .collect();
    let selected_by_id: BTreeMap<&str, &PluginComponentSelection> = selected
        .iter()
        .map(|entry| (entry.plugin_id.as_str(), entry))
        .collect();

    for entry in &selected {
        let plugin = plugins_by_id
            .get(entry.plugin_id.as_str())
            .ok_or(RepositoryError::Conflict)?;
        if plugin.package_generation != entry.package_generation
            || plugin.activation_epoch != entry.activation_epoch
            || !plugin.desired_enabled
            || !matches!(
                plugin.runtime_state,
                PluginRuntimeState::Starting | PluginRuntimeState::Active
            )
            || plugin
                .manifest
                .dependencies
                .iter()
                .any(|dependency| !selected_by_id.contains_key(dependency.id.as_str()))
        {
            return Err(RepositoryError::Conflict);
        }
    }

    let dependency_order: Vec<&InstalledPlugin> = profile
        .activation_order
        .iter()
        .filter_map(|plugin_id| {
            selected_by_id
                .contains_key(plugin_id.as_str())
                .then(|| plugins_by_id.get(plugin_id.as_str()).copied())
                .flatten()
        })
        .collect();
    if dependency_order.len() != selected.len() {
        return Err(RepositoryError::Conflict);
    }

    let mut opened = Vec::with_capacity(dependency_order.len());
    for plugin in dependency_order {
        let grants = list_plugin_grants(&transaction, plugin.plugin_id.clone())?;
        let permissions: Vec<_> = grants.into_iter().map(|grant| grant.permission).collect();
        let grant_authority =
            validate_permission_grants(&plugin.manifest.permissions, &permissions)
                .map_err(storage_error)?;
        let permission_hash = persisted_plugin_permission_hash(&transaction, &plugin.plugin_id)?;
        if permission_hash != Sha256Digest::from_bytes(grant_authority.requested_hash)
            || permission_hash != manifest_permission_hash(&plugin.manifest)?
        {
            return Err(RepositoryError::Conflict);
        }

        let package = store
            .open_component_package(&plugin.package_sha256)
            .map_err(|_| RepositoryError::Conflict)?;
        let authority = &package.authority;
        if authority.plugin_id() != &plugin.plugin_id
            || authority.manifest() != &plugin.manifest
            || authority.package_sha256() != &plugin.package_sha256
            || authority.component_sha256() != &plugin.component_sha256
            || authority.publisher_key_id() != &plugin.publisher_key_id
            || authority.publisher_public_key()
                != &active_publisher_key(&transaction, &plugin.publisher_key_id)?
        {
            return Err(RepositoryError::Conflict);
        }
        let component_length = authority.component_size();
        let import_export_fingerprint =
            Sha256Digest::parse(package.component.import_export_fingerprint)
                .map_err(storage_error)?;
        opened.push(
            OpenedPluginComponentSource::from_verified_package_file(
                package.file,
                plugin.plugin_id.clone(),
                plugin.package_generation,
                plugin.activation_epoch,
                package.component_offset,
                component_length,
                plugin.component_sha256.clone(),
                plugin.manifest.runtime_profile,
                import_export_fingerprint,
                permission_hash,
                permissions,
            )
            .map_err(|_| RepositoryError::Conflict)?,
        );
    }
    transaction.commit().map_err(storage_error)?;
    Ok(opened)
}

fn dependent_closure(plugins: &[InstalledPlugin], target: &PluginId) -> Vec<PluginId> {
    let mut closure = BTreeSet::new();
    let mut queue = VecDeque::from([target.to_string()]);
    while let Some(dependency_id) = queue.pop_front() {
        for plugin in plugins {
            if !closure.contains(&plugin.plugin_id)
                && plugin
                    .manifest
                    .dependencies
                    .iter()
                    .any(|dependency| dependency.id == dependency_id)
            {
                closure.insert(plugin.plugin_id.clone());
                queue.push_back(plugin.plugin_id.to_string());
            }
        }
    }
    closure.into_iter().take(PLUGIN_DEPENDENTS_MAX).collect()
}

fn dependency_closure(plugins: &[InstalledPlugin], target: &PluginId) -> Vec<PluginId> {
    let by_id: BTreeMap<&str, &InstalledPlugin> = plugins
        .iter()
        .map(|plugin| (plugin.plugin_id.as_str(), plugin))
        .collect();
    let mut result = BTreeSet::new();
    let mut queue = VecDeque::from([target.to_string()]);
    while let Some(id) = queue.pop_front() {
        if let Some(plugin) = by_id.get(id.as_str()) {
            for dependency in &plugin.manifest.dependencies {
                let parsed = PluginId::parse(dependency.id.clone()).expect("validated manifest id");
                if result.insert(parsed) {
                    queue.push_back(dependency.id.clone());
                }
            }
        }
    }
    result.into_iter().collect()
}

fn next_package_generation(connection: &Connection) -> Result<u64, RepositoryError> {
    let value: i64 = connection
        .query_row(
            "SELECT next_package_generation FROM plugin_profile_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let generation = parse_u64(value, "generation sequence")?;
    if generation == 0 || generation == i64::MAX as u64 {
        return Err(RepositoryError::Storage(
            "plugin package generation overflow".to_owned(),
        ));
    }
    Ok(generation)
}

fn allocate_generation(
    connection: &Connection,
    generation: u64,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    let next = generation
        .checked_add(1)
        .ok_or_else(|| RepositoryError::Storage("plugin package generation overflow".to_owned()))?;
    let changed = connection
        .execute(
            "UPDATE plugin_profile_state
             SET next_package_generation = ?1, updated_at = ?3
             WHERE singleton = 1 AND next_package_generation = ?2",
            params![
                as_i64(next, "generation")?,
                as_i64(generation, "generation")?,
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

fn next_activation_epoch(current: u64) -> Result<u64, RepositoryError> {
    current
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| RepositoryError::Storage("plugin activation epoch overflow".to_owned()))
}

fn plugin_effect(
    event_type: &'static str,
    primary: Option<&InstalledPlugin>,
    mut affected: Vec<PluginId>,
    subject: Option<String>,
) -> MutationEffect {
    affected.sort();
    affected.dedup();
    MutationEffect {
        event_type: EventType::new(event_type),
        primary: primary.map(|plugin| ResourceRef::plugin(&plugin.plugin_id)),
        snapshot: primary.map(|plugin| ResourceSnapshot::plugin(plugin.summary())),
        affected: AffectedIds {
            plugin_ids: affected,
            ..AffectedIds::default()
        },
        resync: ResyncScope::PLUGINS,
        task_activity: Vec::new(),
        summary_subject: subject.map(|id| ("plugin".to_owned(), id)),
        undo: None,
        mark_undone: None,
        uncomplete_outcome: None,
    }
}

fn deleted_plugin_effect(plugin_id: &PluginId) -> MutationEffect {
    let mut effect = plugin_effect(
        EventType::PLUGIN_UNINSTALLED,
        None,
        vec![plugin_id.clone()],
        Some(plugin_id.to_string()),
    );
    effect.primary = Some(ResourceRef::plugin(plugin_id));
    effect
}

fn rewrite_locks(
    connection: &Connection,
    locks: &[DependencyLock],
    now: Timestamp,
) -> Result<(), RepositoryError> {
    connection
        .execute("DELETE FROM plugin_dependency_locks", [])
        .map_err(storage_error)?;
    for lock in locks {
        connection
            .execute(
                "INSERT INTO plugin_dependency_locks(
                    plugin_id, dependency_id, version_requirement, resolved_version,
                    dependency_package_generation, dependency_package_sha256, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    lock.plugin_id,
                    lock.dependency_id,
                    lock.version_requirement,
                    lock.resolved_version,
                    as_i64(lock.dependency_package_generation, "dependency generation")?,
                    lock.dependency_package_sha256,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
    }
    Ok(())
}

fn validate_existing_settings(
    connection: &Connection,
    plugin_id: &PluginId,
    candidate: &RuntimeManifest,
) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT setting_key, value_json FROM plugin_settings
             WHERE plugin_id = ?1 ORDER BY setting_key",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([plugin_id.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (key, raw) = row.map_err(storage_error)?;
        let value: SettingValue = serde_json::from_str(&raw).map_err(storage_error)?;
        candidate
            .validate_persisted_setting(&key, &value)
            .map_err(|_| RepositoryError::Conflict)?;
    }
    Ok(())
}

fn graph_rejection(error: GraphError) -> PluginGraphRejection {
    PluginGraphRejection::try_from(error).unwrap_or(PluginGraphRejection::InvalidPackageAuthority)
}

fn verify_installed_package(
    store: &PluginPackageStore,
    plugin: &InstalledPlugin,
) -> Result<(), RepositoryError> {
    let authority = store
        .read_authority(&plugin.package_sha256)
        .map_err(|_| RepositoryError::Conflict)?;
    if authority.plugin_id() != &plugin.plugin_id
        || authority.manifest() != &plugin.manifest
        || authority.package_sha256() != &plugin.package_sha256
        || authority.component_sha256() != &plugin.component_sha256
        || authority.publisher_key_id() != &plugin.publisher_key_id
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

fn publisher_is_trusted(
    connection: &Connection,
    key_id: &Sha256Digest,
) -> Result<bool, RepositoryError> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM plugin_publisher_trust
                WHERE key_id = ?1 AND status = 'active'
             )",
            [key_id.as_str()],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn trust_allows_install(
    connection: &Connection,
    request: &InstallPluginRequest,
) -> Result<(), RepositoryError> {
    match request.source {
        PluginInstallSource::CommunityRegistry | PluginInstallSource::LocalPackage => {
            let policy = get_community_plugin_policy(connection)?;
            if !policy.community_registry_enabled
                || !publisher_is_trusted(connection, request.package.publisher_key_id())?
            {
                return Err(RepositoryError::Conflict);
            }
            Ok(())
        }
        // The later signed-registry adapter must supply an unforgeable bundled
        // authority. A caller-selected enum value cannot bypass Restricted Mode.
        PluginInstallSource::BundledRegistry => Err(RepositoryError::Conflict),
    }
}

pub(crate) fn install_plugin(
    connection: &mut Connection,
    store: &PluginPackageStore,
    operation_id: OperationId,
    request: InstallPluginRequest,
    now: Timestamp,
) -> Result<PluginMutationOutcome, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::Install { request: &request })?;
    let outcome = Rc::new(RefCell::new(None));
    let captured = Rc::clone(&outcome);
    let replaced_digest = Rc::new(RefCell::new(None));
    let captured_digest = Rc::clone(&replaced_digest);
    let result = mutate(
        connection,
        operation_id,
        request_json,
        now,
        move |tx, revision| {
            let stored_package = store
                .read_authority(request.package.package_sha256())
                .map_err(|_| RepositoryError::Conflict)?;
            if stored_package != request.package {
                return Err(RepositoryError::Conflict);
            }
            let mut plugins = load_plugins(tx)?;
            validate_current_graph(tx, &plugins)?;
            let plugin_id = request.package.plugin_id().clone();
            let existing_index = plugins
                .iter()
                .position(|plugin| plugin.plugin_id == plugin_id);
            if existing_index.is_none() && plugins.len() == PLUGINS_INSTALLED_MAX {
                return Err(RepositoryError::OperationTooLarge);
            }
            trust_allows_install(tx, &request)?;
            let existing = existing_index.map(|index| plugins[index].clone());
            if let Some(installed) = &existing {
                if !request.replace_existing
                    || request.package.publisher_key_id() != &installed.publisher_key_id
                    || now < installed.updated_at
                {
                    return Err(RepositoryError::Conflict);
                }
                if compare_versions(
                    request.package.manifest().version.as_str(),
                    &installed.version,
                )
                .map_err(storage_error)?
                .is_lt()
                    && !request.allow_downgrade
                {
                    return Err(RepositoryError::Conflict);
                }
                validate_existing_settings(tx, &plugin_id, request.package.manifest())?;
            }

            let generation = next_package_generation(tx)?;
            let activation_epoch = match &existing {
                Some(installed) => next_activation_epoch(installed.activation_epoch)?,
                None => 0,
            };
            let candidate = InstalledPlugin {
                plugin_id: plugin_id.clone(),
                manifest: request.package.manifest().clone(),
                version: request.package.manifest().version.clone(),
                package_sha256: request.package.package_sha256().clone(),
                component_sha256: request.package.component_sha256().clone(),
                publisher_key_id: request.package.publisher_key_id().clone(),
                package_generation: generation,
                activation_epoch,
                // A package generation never inherits activation or grants. The
                // operator must review grants and explicitly enable the new authority.
                desired_enabled: false,
                runtime_state: PluginRuntimeState::Disabled,
                granted_capabilities: Vec::new(),
                dependencies_satisfied: true,
                failure_count: 0,
                last_error_code: None,
                next_retry_at: None,
                installed_at: existing.as_ref().map_or(now, |value| value.installed_at),
                updated_at: now,
            };
            match existing_index {
                Some(index) => plugins[index] = candidate.clone(),
                None => plugins.push(candidate.clone()),
            }
            plugins.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
            if existing.is_some() {
                let mut incompatible_dependent = false;
                for dependent in &plugins {
                    for dependency in &dependent.manifest.dependencies {
                        if dependency.id == plugin_id.as_str()
                            && (!version_matches(&dependency.requirement, &candidate.version)
                                .map_err(storage_error)?
                                || dependency.services.iter().any(|required| {
                                    !candidate
                                        .manifest
                                        .services
                                        .iter()
                                        .any(|service| service.id == *required)
                                }))
                        {
                            incompatible_dependent = true;
                        }
                    }
                }
                if incompatible_dependent {
                    *captured.borrow_mut() = Some(PluginMutationOutcome::BlockedByDependents(
                        dependent_closure(&plugins, &plugin_id),
                    ));
                    return Err(RepositoryError::Conflict);
                }
            }
            let graph = match validate_dependency_graph(&sdk_packages(&plugins)) {
                Ok(graph) => graph,
                Err(error) => {
                    *captured.borrow_mut() =
                        Some(PluginMutationOutcome::GraphRejected(graph_rejection(error)));
                    return Err(RepositoryError::Conflict);
                }
            };
            let locks = expected_locks(&plugins)?;
            if graph.activation_order.len() != plugins.len() {
                return Err(RepositoryError::Conflict);
            }
            let dependent_ids = if existing.is_some() {
                dependent_closure(&plugins, &plugin_id)
            } else {
                Vec::new()
            };
            let mut dependent_epochs = Vec::new();
            if existing.is_some() {
                ensure_no_plugin_invocations(tx, &plugin_id)?;
                for dependent in &dependent_ids {
                    ensure_no_plugin_invocations(tx, dependent)?;
                    let current = plugins
                        .iter()
                        .find(|plugin| plugin.plugin_id == *dependent)
                        .ok_or(RepositoryError::NotFound)?;
                    if current.desired_enabled {
                        if now < current.updated_at {
                            return Err(RepositoryError::Conflict);
                        }
                        dependent_epochs.push((
                            dependent.clone(),
                            next_activation_epoch(current.activation_epoch)?,
                        ));
                    }
                }
            }

            // Every bound and candidate invariant above precedes the generation allocation.
            allocate_generation(tx, generation, now)?;
            tx.execute("DELETE FROM plugin_dependency_locks", [])
                .map_err(storage_error)?;
            if existing.is_some() {
                tx.execute(
                    "DELETE FROM plugin_grants WHERE plugin_id = ?1",
                    [plugin_id.as_str()],
                )
                .map_err(storage_error)?;
                tx.execute(
                    "DELETE FROM plugin_invocations WHERE plugin_id = ?1",
                    [plugin_id.as_str()],
                )
                .map_err(storage_error)?;
                tx.execute(
                    "UPDATE plugins SET
                    manifest_json = ?2, version = ?3, package_sha256 = ?4,
                    component_sha256 = ?5, publisher_key_id = ?6,
                    permission_hash = ?7, compatibility = ?8,
                    package_generation = ?9, activation_epoch = ?10,
                    desired_enabled = 0, runtime_state = 'disabled',
                    failure_count = 0, last_error_code = NULL, next_retry_at = NULL,
                    updated_at = ?11
                 WHERE plugin_id = ?1",
                    params![
                        plugin_id.as_str(),
                        serde_json::to_string(request.package.manifest()).map_err(storage_error)?,
                        candidate.version,
                        candidate.package_sha256.as_str(),
                        candidate.component_sha256.as_str(),
                        candidate.publisher_key_id.as_str(),
                        Sha256Digest::from_bytes(
                            permission_set_hash(&candidate.manifest.permissions)
                                .map_err(storage_error)?,
                        )
                        .as_str(),
                        candidate.manifest.junban_compatibility.as_str(),
                        as_i64(generation, "generation")?,
                        as_i64(activation_epoch, "activation epoch")?,
                        now.to_string(),
                    ],
                )
                .map_err(storage_error)?;
            } else {
                tx.execute(
                    "INSERT INTO plugins(
                    plugin_id, package_generation, activation_epoch, package_sha256,
                    component_sha256, publisher_key_id, version, manifest_json,
                    permission_hash, compatibility, desired_enabled, runtime_state,
                    failure_count, last_error_code, next_retry_at, installed_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0,
                           'disabled', 0, NULL, NULL, ?11, ?11)",
                    params![
                        plugin_id.as_str(),
                        as_i64(generation, "generation")?,
                        as_i64(activation_epoch, "activation epoch")?,
                        candidate.package_sha256.as_str(),
                        candidate.component_sha256.as_str(),
                        candidate.publisher_key_id.as_str(),
                        candidate.version,
                        serde_json::to_string(request.package.manifest()).map_err(storage_error)?,
                        Sha256Digest::from_bytes(
                            permission_set_hash(&candidate.manifest.permissions)
                                .map_err(storage_error)?,
                        )
                        .as_str(),
                        candidate.manifest.junban_compatibility.as_str(),
                        now.to_string(),
                    ],
                )
                .map_err(storage_error)?;
                let event_epoch: String = tx
                    .query_row(
                        "SELECT event_epoch FROM app_state WHERE singleton = 1",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(storage_error)?;
                tx.execute(
                    "INSERT INTO plugin_event_cursors(
                    plugin_id, event_epoch, revision, resync_required, updated_at
                 ) VALUES (?1, ?2, ?3, 1, ?4)",
                    params![
                        plugin_id.as_str(),
                        event_epoch,
                        revision_to_i64(revision)?,
                        now.to_string()
                    ],
                )
                .map_err(storage_error)?;
            }

            let mut affected = vec![plugin_id.clone()];
            if existing.is_some() {
                for (dependent, epoch) in &dependent_epochs {
                    tx.execute(
                        "UPDATE plugins SET activation_epoch = ?2,
                        runtime_state = 'starting', failure_count = 0,
                        last_error_code = NULL, next_retry_at = NULL, updated_at = ?3
                     WHERE plugin_id = ?1",
                        params![
                            dependent.as_str(),
                            as_i64(*epoch, "activation epoch")?,
                            now.to_string()
                        ],
                    )
                    .map_err(storage_error)?;
                    tx.execute(
                        "DELETE FROM plugin_invocations WHERE plugin_id = ?1",
                        [dependent.as_str()],
                    )
                    .map_err(storage_error)?;
                    tx.execute(
                        "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
                     WHERE plugin_id = ?1",
                        params![dependent.as_str(), now.to_string()],
                    )
                    .map_err(storage_error)?;
                }
                affected.extend(dependent_ids);
            }
            affected.sort();
            affected.dedup();
            rewrite_locks(tx, &locks, now)?;
            tx.execute(
                "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
             WHERE plugin_id = ?1",
                params![plugin_id.as_str(), now.to_string()],
            )
            .map_err(storage_error)?;
            let stored = load_installed_plugin(tx, &plugin_id)?;
            let event_type = if existing.is_some() {
                EventType::PLUGIN_REPLACED
            } else {
                EventType::PLUGIN_INSTALLED
            };
            if let Some(installed) = existing {
                *captured_digest.borrow_mut() = Some(installed.package_sha256);
            }
            Ok(plugin_effect(
                event_type,
                Some(&stored),
                affected,
                Some(plugin_id.to_string()),
            ))
        },
    );
    match result {
        Ok(mutation) => {
            if mutation.newly_committed
                && let Some(digest) = replaced_digest.borrow_mut().take()
            {
                let _ = store.remove_if_unreferenced(connection, &digest);
            }
            Ok(PluginMutationOutcome::Committed(Box::new(mutation)))
        }
        Err(RepositoryError::Conflict) => {
            outcome.borrow_mut().take().ok_or(RepositoryError::Conflict)
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn install_plugin_admission(
    connection: &mut Connection,
    store: &PluginPackageStore,
    operation_id: OperationId,
    admission: PluginPackageAdmission,
    request: InstallPluginRequest,
    now: Timestamp,
) -> Result<PluginMutationOutcome, RepositoryError> {
    let (staged, inspected) = admission.into_parts();
    if request.package != inspected {
        return Err(RepositoryError::Conflict);
    }
    let published = store
        .publish_expected(staged, &inspected)
        .map_err(|_| RepositoryError::Conflict)?;
    if published != inspected {
        let _ = store.remove_if_unreferenced(connection, published.package_sha256());
        return Err(RepositoryError::Conflict);
    }
    let digest = published.package_sha256().clone();
    let result = install_plugin(
        connection,
        store,
        operation_id,
        InstallPluginRequest {
            package: published,
            source: request.source,
            replace_existing: request.replace_existing,
            allow_downgrade: request.allow_downgrade,
        },
        now,
    );
    let should_cleanup = match &result {
        Ok(PluginMutationOutcome::Committed(mutation)) => !mutation.newly_committed,
        Ok(
            PluginMutationOutcome::BlockedByDependents(_) | PluginMutationOutcome::GraphRejected(_),
        )
        | Err(_) => true,
    };
    if should_cleanup {
        let _ = store.remove_if_unreferenced(connection, &digest);
    }
    result
}

pub(crate) fn uninstall_plugin(
    connection: &mut Connection,
    store: &PluginPackageStore,
    operation_id: OperationId,
    plugin_id: PluginId,
    now: Timestamp,
) -> Result<PluginMutationOutcome, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::Uninstall {
        plugin_id: &plugin_id,
    })?;
    let outcome = Rc::new(RefCell::new(None));
    let captured = Rc::clone(&outcome);
    let removed_digest = Rc::new(RefCell::new(None));
    let captured_digest = Rc::clone(&removed_digest);
    let result = mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let installed = plugins
            .iter()
            .find(|plugin| plugin.plugin_id == plugin_id)
            .cloned()
            .ok_or(RepositoryError::NotFound)?;
        let dependents = dependent_closure(&plugins, &plugin_id);
        if !dependents.is_empty() {
            *captured.borrow_mut() = Some(PluginMutationOutcome::BlockedByDependents(dependents));
            return Err(RepositoryError::Conflict);
        }
        ensure_no_plugin_invocations(tx, &plugin_id)?;
        let remaining: Vec<_> = plugins
            .into_iter()
            .filter(|plugin| plugin.plugin_id != plugin_id)
            .collect();
        let locks = expected_locks(&remaining)?;
        validate_dependency_graph(&sdk_packages(&remaining)).map_err(storage_error)?;
        // Metadata disappears before content cleanup is attempted.
        tx.execute(
            "DELETE FROM plugins WHERE plugin_id = ?1",
            [plugin_id.as_str()],
        )
        .map_err(storage_error)?;
        rewrite_locks(tx, &locks, now)?;
        *captured_digest.borrow_mut() = Some(installed.package_sha256);
        Ok(deleted_plugin_effect(&plugin_id))
    });
    match result {
        Ok(mutation) => {
            if mutation.newly_committed
                && let Some(digest) = removed_digest.borrow_mut().take()
            {
                let _ = store.remove_if_unreferenced(connection, &digest);
            }
            Ok(PluginMutationOutcome::Committed(Box::new(mutation)))
        }
        Err(RepositoryError::Conflict) => {
            outcome.borrow_mut().take().ok_or(RepositoryError::Conflict)
        }
        Err(error) => Err(error),
    }
}

fn ensure_no_plugin_invocations(
    connection: &Connection,
    plugin_id: &PluginId,
) -> Result<(), RepositoryError> {
    let present: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_invocations WHERE plugin_id = ?1)",
            [plugin_id.as_str()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if present {
        Err(RepositoryError::Conflict)
    } else {
        Ok(())
    }
}

fn bump_plugin_authority_with_ambiguity(
    connection: &Connection,
    plugin: &InstalledPlugin,
    desired_enabled: bool,
    preserve_http_ambiguity: bool,
    now: Timestamp,
) -> Result<InstalledPlugin, RepositoryError> {
    if now < plugin.updated_at {
        return Err(RepositoryError::Conflict);
    }
    let (invocations, ambiguous): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(state = 'ambiguous_http'), 0)
             FROM plugin_invocations WHERE plugin_id = ?1",
            [plugin.plugin_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if invocations != ambiguous || (invocations > 0 && !preserve_http_ambiguity) {
        return Err(RepositoryError::Conflict);
    }
    if invocations > 0 {
        connection
            .execute_batch("PRAGMA defer_foreign_keys = ON;")
            .map_err(storage_error)?;
    }
    let epoch = next_activation_epoch(plugin.activation_epoch)?;
    connection
        .execute(
            "UPDATE plugins SET activation_epoch = ?2, desired_enabled = ?3,
                runtime_state = ?4, failure_count = 0, last_error_code = NULL,
                next_retry_at = NULL, updated_at = ?5 WHERE plugin_id = ?1",
            params![
                plugin.plugin_id.as_str(),
                as_i64(epoch, "activation epoch")?,
                i64::from(desired_enabled),
                if desired_enabled {
                    "starting"
                } else {
                    "disabled"
                },
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
    if preserve_http_ambiguity {
        connection
            .execute(
                "UPDATE plugin_invocations SET activation_epoch = ?2
                 WHERE plugin_id = ?1 AND state = 'ambiguous_http'",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(epoch, "activation epoch")?,
                ],
            )
            .map_err(storage_error)?;
    }
    connection
        .execute(
            "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
             WHERE plugin_id = ?1",
            params![plugin.plugin_id.as_str(), now.to_string()],
        )
        .map_err(storage_error)?;
    load_installed_plugin(connection, &plugin.plugin_id)
}

fn force_suspend_plugin(
    connection: &Connection,
    plugin: &InstalledPlugin,
    error_code: &'static str,
    now: Timestamp,
) -> Result<InstalledPlugin, RepositoryError> {
    connection
        .execute(
            "UPDATE plugin_invocations
             SET state = 'ambiguous_http', error_code = 'http_ambiguous'
             WHERE plugin_id = ?1 AND state = 'dispatching_http'",
            [plugin.plugin_id.as_str()],
        )
        .map_err(storage_error)?;
    connection
        .execute(
            "DELETE FROM plugin_invocations
             WHERE plugin_id = ?1 AND state IN ('reserved', 'effect_committing')",
            [plugin.plugin_id.as_str()],
        )
        .map_err(storage_error)?;
    let fenced = fence_disabled_plugin_authority(connection, plugin, now)?;
    connection
        .execute(
            "UPDATE plugins SET runtime_state = 'suspended', failure_count = 3,
                last_error_code = ?2, next_retry_at = NULL, updated_at = ?3
             WHERE plugin_id = ?1",
            params![plugin.plugin_id.as_str(), error_code, now.to_string()],
        )
        .map_err(storage_error)?;
    load_installed_plugin(connection, &fenced.plugin_id)
}

fn fence_disabled_plugin_authority(
    connection: &Connection,
    plugin: &InstalledPlugin,
    now: Timestamp,
) -> Result<InstalledPlugin, RepositoryError> {
    if now < plugin.updated_at {
        return Err(RepositoryError::Conflict);
    }
    if plugin.desired_enabled {
        return bump_plugin_authority_with_ambiguity(connection, plugin, false, true, now);
    }
    let (invocations, ambiguous): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(state = 'ambiguous_http'), 0)
             FROM plugin_invocations WHERE plugin_id = ?1",
            [plugin.plugin_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if invocations != ambiguous {
        return Err(RepositoryError::Conflict);
    }
    if invocations > 0 {
        connection
            .execute_batch("PRAGMA defer_foreign_keys = ON;")
            .map_err(storage_error)?;
    }
    let epoch = next_activation_epoch(plugin.activation_epoch)?;
    connection
        .execute(
            "UPDATE plugins SET activation_epoch = ?2, updated_at = ?3 WHERE plugin_id = ?1",
            params![
                plugin.plugin_id.as_str(),
                as_i64(epoch, "activation epoch")?,
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
    connection
        .execute(
            "UPDATE plugin_invocations SET activation_epoch = ?2
             WHERE plugin_id = ?1 AND state = 'ambiguous_http'",
            params![
                plugin.plugin_id.as_str(),
                as_i64(epoch, "activation epoch")?,
            ],
        )
        .map_err(storage_error)?;
    connection
        .execute(
            "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
             WHERE plugin_id = ?1",
            params![plugin.plugin_id.as_str(), now.to_string()],
        )
        .map_err(storage_error)?;
    load_installed_plugin(connection, &plugin.plugin_id)
}

pub(crate) fn set_plugin_desired_enabled(
    connection: &mut Connection,
    store: &PluginPackageStore,
    operation_id: OperationId,
    plugin_id: PluginId,
    enabled: bool,
    now: Timestamp,
) -> Result<PluginMutationOutcome, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::SetDesiredEnabled {
        plugin_id: &plugin_id,
        enabled,
    })?;
    let outcome = Rc::new(RefCell::new(None));
    let captured = Rc::clone(&outcome);
    let result = mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .iter()
            .find(|value| value.plugin_id == plugin_id)
            .cloned()
            .ok_or(RepositoryError::NotFound)?;
        if (enabled
            && (plugin.desired_enabled || plugin.runtime_state != PluginRuntimeState::Disabled))
            || (!enabled && !plugin.desired_enabled)
        {
            return Err(RepositoryError::Conflict);
        }
        if enabled
            && plugins.iter().filter(|value| value.desired_enabled).count() >= PLUGINS_ENABLED_MAX
        {
            return Err(RepositoryError::OperationTooLarge);
        }
        if enabled {
            verify_installed_package(store, &plugin)?;
            if !publisher_is_trusted(tx, &plugin.publisher_key_id)? {
                return Err(RepositoryError::Conflict);
            }
            let dependencies = dependency_closure(&plugins, &plugin_id);
            if dependencies.iter().any(|dependency| {
                plugins
                    .iter()
                    .find(|item| item.plugin_id == *dependency)
                    .is_none_or(|item| !item.desired_enabled)
            }) {
                return Err(RepositoryError::Conflict);
            }
        } else {
            let blocked: Vec<_> = dependent_closure(&plugins, &plugin_id)
                .into_iter()
                .filter(|dependent| {
                    plugins
                        .iter()
                        .find(|item| item.plugin_id == *dependent)
                        .is_some_and(|item| item.desired_enabled)
                })
                .collect();
            if !blocked.is_empty() {
                *captured.borrow_mut() = Some(PluginMutationOutcome::BlockedByDependents(blocked));
                return Err(RepositoryError::Conflict);
            }
        }
        let stored = bump_plugin_authority_with_ambiguity(tx, &plugin, enabled, !enabled, now)?;
        Ok(plugin_effect(
            if enabled {
                EventType::PLUGIN_ENABLED
            } else {
                EventType::PLUGIN_DISABLED
            },
            Some(&stored),
            vec![plugin_id.clone()],
            Some(plugin_id.to_string()),
        ))
    });
    match result {
        Ok(mutation) => Ok(PluginMutationOutcome::Committed(Box::new(mutation))),
        Err(RepositoryError::Conflict) => {
            outcome.borrow_mut().take().ok_or(RepositoryError::Conflict)
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn retry_plugin(
    connection: &mut Connection,
    store: &PluginPackageStore,
    operation_id: OperationId,
    plugin_id: PluginId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::Retry {
        plugin_id: &plugin_id,
    })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.plugin_id == plugin_id)
            .cloned()
            .ok_or(RepositoryError::NotFound)?;
        if !matches!(
            plugin.runtime_state,
            PluginRuntimeState::Degraded
                | PluginRuntimeState::Failed
                | PluginRuntimeState::Suspended
                | PluginRuntimeState::ReverifyRequired
        ) {
            return Err(RepositoryError::Conflict);
        }
        if !plugin.desired_enabled
            && plugins
                .iter()
                .filter(|candidate| candidate.desired_enabled)
                .count()
                >= PLUGINS_ENABLED_MAX
        {
            return Err(RepositoryError::OperationTooLarge);
        }
        verify_installed_package(store, &plugin)?;
        if !publisher_is_trusted(tx, &plugin.publisher_key_id)? {
            return Err(RepositoryError::Conflict);
        }
        if dependency_closure(&plugins, &plugin_id)
            .iter()
            .any(|dependency| {
                plugins
                    .iter()
                    .find(|candidate| candidate.plugin_id == *dependency)
                    .is_none_or(|candidate| !candidate.desired_enabled)
            })
        {
            return Err(RepositoryError::Conflict);
        }
        let stored = bump_plugin_authority_with_ambiguity(tx, &plugin, true, true, now)?;
        Ok(plugin_effect(
            EventType::PLUGIN_RETRY_REQUESTED,
            Some(&stored),
            vec![plugin_id.clone()],
            Some(plugin_id.to_string()),
        ))
    })
}

pub(crate) fn list_publisher_trust(
    connection: &Connection,
) -> Result<Vec<PublisherTrust>, RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT key_id, public_key, status, trusted_at, revoked_at
             FROM plugin_publisher_trust ORDER BY key_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(storage_error)?;
    let mut out = Vec::new();
    for row in rows {
        let (key_id, public_key, status, trusted_at, revoked_at) = row.map_err(storage_error)?;
        let public_key: [u8; 32] = public_key
            .try_into()
            .map_err(|_| RepositoryError::Storage("invalid publisher key".to_owned()))?;
        let key_id = Sha256Digest::parse(key_id).map_err(storage_error)?;
        if junban_plugin_sdk::validate_signer_public_key(&public_key).map_err(storage_error)?
            != key_id
        {
            return Err(RepositoryError::Storage(
                "publisher key identity mismatch".to_owned(),
            ));
        }
        out.push(PublisherTrust {
            key_id,
            public_key,
            status: match status.as_str() {
                "active" => PublisherTrustStatus::Active,
                "revoked" => PublisherTrustStatus::Revoked,
                _ => {
                    return Err(RepositoryError::Storage(
                        "invalid publisher trust status".to_owned(),
                    ));
                }
            },
            trusted_at: parse_timestamp(&trusted_at, "trust timestamp")?,
            revoked_at: revoked_at
                .as_deref()
                .map(|value| parse_timestamp(value, "revocation timestamp"))
                .transpose()?,
        });
    }
    Ok(out)
}

pub(crate) fn trust_publisher(
    connection: &mut Connection,
    operation_id: OperationId,
    request: TrustPublisherRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::TrustPublisher { request: &request })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        if junban_plugin_sdk::validate_signer_public_key(&request.public_key)
            .ok()
            .is_none_or(|key_id| key_id != request.key_id)
        {
            return Err(RepositoryError::Conflict);
        }
        let existing: Option<Vec<u8>> = tx
            .query_row(
                "SELECT public_key FROM plugin_publisher_trust WHERE key_id = ?1",
                [request.key_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if existing
            .as_deref()
            .is_some_and(|value| value != request.public_key)
        {
            return Err(RepositoryError::Conflict);
        }
        if existing.is_none() {
            let count: i64 = tx
                .query_row("SELECT COUNT(*) FROM plugin_publisher_trust", [], |row| {
                    row.get(0)
                })
                .map_err(storage_error)?;
            if count >= junban_plugin_sdk::SIGNER_TRUST_RECORDS_MAX as i64 {
                return Err(RepositoryError::OperationTooLarge);
            }
        }
        let all_plugins = load_plugins(tx)?;
        validate_current_graph(tx, &all_plugins)?;
        let affected: Vec<_> = all_plugins
            .into_iter()
            .filter(|plugin| plugin.publisher_key_id == request.key_id)
            .map(|plugin| plugin.plugin_id)
            .collect();
        tx.execute(
            "INSERT INTO plugin_publisher_trust(
                key_id, public_key, status, trusted_at, revoked_at
             ) VALUES (?1, ?2, 'active', ?3, NULL)
             ON CONFLICT(key_id) DO UPDATE SET
                status = 'active', trusted_at = excluded.trusted_at, revoked_at = NULL",
            params![
                request.key_id.as_str(),
                request.public_key.as_slice(),
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
        Ok(plugin_effect(
            EventType::PLUGIN_PUBLISHER_TRUSTED,
            None,
            affected,
            None,
        ))
    })
}

pub(crate) fn revoke_publisher(
    connection: &mut Connection,
    operation_id: OperationId,
    key_id: Sha256Digest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::RevokePublisher { key_id: &key_id })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        let trusted_at: String = tx
            .query_row(
                "SELECT trusted_at FROM plugin_publisher_trust WHERE key_id = ?1",
                [key_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or(RepositoryError::NotFound)?;
        if now < parse_timestamp(&trusted_at, "trust timestamp")? {
            return Err(RepositoryError::Conflict);
        }
        let all_plugins = load_plugins(tx)?;
        validate_current_graph(tx, &all_plugins)?;
        let roots: BTreeSet<_> = all_plugins
            .iter()
            .filter(|plugin| plugin.publisher_key_id == key_id)
            .map(|plugin| plugin.plugin_id.clone())
            .collect();
        let mut affected = roots.clone();
        for root in &roots {
            affected.extend(dependent_closure(&all_plugins, root));
        }
        let transitioned: Vec<_> = affected
            .iter()
            .filter(|plugin_id| {
                roots.contains(*plugin_id)
                    || all_plugins
                        .iter()
                        .find(|plugin| plugin.plugin_id == **plugin_id)
                        .is_some_and(|plugin| plugin.desired_enabled)
            })
            .cloned()
            .collect();
        for plugin_id in &transitioned {
            let plugin = all_plugins
                .iter()
                .find(|plugin| plugin.plugin_id == *plugin_id)
                .ok_or(RepositoryError::NotFound)?;
            next_activation_epoch(plugin.activation_epoch)?;
        }
        let changed = tx
            .execute(
                "UPDATE plugin_publisher_trust SET status = 'revoked', revoked_at = ?2
                 WHERE key_id = ?1",
                params![key_id.as_str(), now.to_string()],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(RepositoryError::NotFound);
        }
        for plugin_id in &transitioned {
            let plugin = all_plugins
                .iter()
                .find(|plugin| plugin.plugin_id == *plugin_id)
                .ok_or(RepositoryError::NotFound)?;
            fence_disabled_plugin_authority(tx, plugin, now)?;
        }
        Ok(plugin_effect(
            EventType::PLUGIN_PUBLISHER_REVOKED,
            None,
            affected.into_iter().collect(),
            None,
        ))
    })
}

pub(crate) fn get_community_plugin_policy(
    connection: &Connection,
) -> Result<CommunityPluginPolicy, RepositoryError> {
    connection
        .query_row(
            "SELECT community_enabled, updated_at
             FROM plugin_policy WHERE singleton = 1",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(storage_error)
        .and_then(|(enabled, updated_at)| {
            Ok(CommunityPluginPolicy {
                community_registry_enabled: enabled == 1,
                updated_at: parse_timestamp(&updated_at, "policy timestamp")?,
            })
        })
}

pub(crate) fn set_community_plugin_policy(
    connection: &mut Connection,
    operation_id: OperationId,
    enabled: bool,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::SetCommunityPolicy { enabled })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        tx.execute(
            "UPDATE plugin_policy SET community_enabled = ?1, updated_at = ?2
             WHERE singleton = 1",
            params![i64::from(enabled), now.to_string()],
        )
        .map_err(storage_error)?;
        Ok(plugin_effect(
            EventType::PLUGIN_COMMUNITY_POLICY_UPDATED,
            None,
            Vec::new(),
            None,
        ))
    })
}

fn manifest_permission_hash(manifest: &RuntimeManifest) -> Result<Sha256Digest, RepositoryError> {
    permission_set_hash(&manifest.permissions)
        .map(Sha256Digest::from_bytes)
        .map_err(storage_error)
}

pub(crate) fn list_plugin_grants(
    connection: &Connection,
    plugin_id: PluginId,
) -> Result<Vec<PluginGrant>, RepositoryError> {
    let plugin = load_installed_plugin(connection, &plugin_id)?;
    let expected_hash = manifest_permission_hash(&plugin.manifest)?;
    let mut statement = connection
        .prepare(
            "SELECT package_generation, permission_hash, capability,
                    scope_hash, scope_json, granted_at
             FROM plugin_grants WHERE plugin_id = ?1 ORDER BY capability, scope_hash",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([plugin_id.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(storage_error)?;
    let mut out = Vec::new();
    let mut permissions = Vec::new();
    for row in rows {
        let (generation, package_hash, capability, stored_scope_hash, raw, granted_at) =
            row.map_err(storage_error)?;
        let parsed_capability: Capability =
            serde_json::from_str(&format!("\"{capability}\"")).map_err(storage_error)?;
        let permission = Permission {
            capability: parsed_capability,
            scope: serde_json::from_str::<PermissionScope>(&raw).map_err(storage_error)?,
        };
        let canonical = serde_json::to_string(&permission.scope).map_err(storage_error)?;
        if canonical != raw
            || permission.capability.as_str() != capability
            || Sha256Digest::from_bytes(scope_hash(&permission).map_err(storage_error)?)
                != Sha256Digest::parse(stored_scope_hash).map_err(storage_error)?
            || parse_u64(generation, "grant generation")? != plugin.package_generation
            || Sha256Digest::parse(package_hash).map_err(storage_error)? != expected_hash
        {
            return Err(RepositoryError::Storage(
                "plugin grant authority mismatch".to_owned(),
            ));
        }
        permissions.push(permission.clone());
        out.push(PluginGrant {
            plugin_id: plugin_id.clone(),
            package_generation: plugin.package_generation,
            permission_hash: expected_hash.clone(),
            permission,
            granted_at: parse_timestamp(&granted_at, "grant timestamp")?,
        });
    }
    validate_permission_grants(&plugin.manifest.permissions, &permissions)
        .map_err(storage_error)?;
    Ok(out)
}

fn replace_grants_rows(
    connection: &Connection,
    plugin: &InstalledPlugin,
    permissions: &[Permission],
    expected_hash: &Sha256Digest,
    now: Timestamp,
) -> Result<(), RepositoryError> {
    validate_permission_grants(&plugin.manifest.permissions, permissions).map_err(storage_error)?;
    if manifest_permission_hash(&plugin.manifest)? != *expected_hash {
        return Err(RepositoryError::Conflict);
    }
    connection
        .execute(
            "DELETE FROM plugin_grants WHERE plugin_id = ?1",
            [plugin.plugin_id.as_str()],
        )
        .map_err(storage_error)?;
    for permission in permissions {
        let scope = Sha256Digest::from_bytes(scope_hash(permission).map_err(storage_error)?);
        let raw = serde_json::to_string(&permission.scope).map_err(storage_error)?;
        connection
            .execute(
                "INSERT INTO plugin_grants(
                    plugin_id, package_generation, capability, scope_json,
                    scope_hash, permission_hash, granted_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(plugin.package_generation, "package generation")?,
                    permission.capability.as_str(),
                    raw,
                    scope.as_str(),
                    expected_hash.as_str(),
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
    }
    Ok(())
}

fn finish_authority_mutation(
    connection: &Connection,
    plugin: &InstalledPlugin,
    now: Timestamp,
) -> Result<InstalledPlugin, RepositoryError> {
    bump_plugin_authority_with_ambiguity(connection, plugin, plugin.desired_enabled, true, now)
}

pub(crate) fn replace_plugin_grants(
    connection: &mut Connection,
    operation_id: OperationId,
    request: ReplacePluginGrantsRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::ReplaceGrants { request: &request })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .into_iter()
            .find(|plugin| plugin.plugin_id == request.plugin_id)
            .ok_or(RepositoryError::NotFound)?;
        if plugin.package_generation != request.package_generation {
            return Err(RepositoryError::Conflict);
        }
        replace_grants_rows(
            tx,
            &plugin,
            &request.permissions,
            &request.permission_hash,
            now,
        )?;
        let stored = finish_authority_mutation(tx, &plugin, now)?;
        Ok(plugin_effect(
            EventType::PLUGIN_GRANTS_REPLACED,
            Some(&stored),
            vec![request.plugin_id.clone()],
            Some(request.plugin_id.to_string()),
        ))
    })
}

pub(crate) fn revoke_plugin_grants(
    connection: &mut Connection,
    operation_id: OperationId,
    request: RevokePluginGrantsRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::RevokeGrants { request: &request })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.plugin_id == request.plugin_id)
            .cloned()
            .ok_or(RepositoryError::NotFound)?;
        if plugin.package_generation != request.package_generation
            || manifest_permission_hash(&plugin.manifest)? != request.permission_hash
        {
            return Err(RepositoryError::Conflict);
        }
        let dependents = dependent_closure(&plugins, &request.plugin_id);
        let enabled_dependents: Vec<_> = dependents
            .iter()
            .filter(|dependent| {
                plugins
                    .iter()
                    .find(|plugin| plugin.plugin_id == **dependent)
                    .is_some_and(|plugin| plugin.desired_enabled)
            })
            .cloned()
            .collect();
        next_activation_epoch(plugin.activation_epoch)?;
        for dependent in &enabled_dependents {
            let dependent = plugins
                .iter()
                .find(|plugin| plugin.plugin_id == *dependent)
                .ok_or(RepositoryError::NotFound)?;
            next_activation_epoch(dependent.activation_epoch)?;
        }
        tx.execute(
            "DELETE FROM plugin_grants WHERE plugin_id = ?1",
            [request.plugin_id.as_str()],
        )
        .map_err(storage_error)?;
        let stored = fence_disabled_plugin_authority(tx, &plugin, now)?;
        for dependent in &enabled_dependents {
            let dependent = plugins
                .iter()
                .find(|plugin| plugin.plugin_id == *dependent)
                .ok_or(RepositoryError::NotFound)?;
            bump_plugin_authority_with_ambiguity(tx, dependent, false, true, now)?;
        }
        let mut affected = vec![request.plugin_id.clone()];
        affected.extend(dependents);
        Ok(plugin_effect(
            EventType::PLUGIN_GRANTS_REVOKED,
            Some(&stored),
            affected,
            Some(request.plugin_id.to_string()),
        ))
    })
}

pub(crate) fn list_plugin_settings(
    connection: &Connection,
    plugin_id: PluginId,
) -> Result<Vec<PluginSetting>, RepositoryError> {
    let plugin = load_installed_plugin(connection, &plugin_id)?;
    let mut statement = connection
        .prepare(
            "SELECT setting_key, value_json, updated_at FROM plugin_settings
             WHERE plugin_id = ?1 ORDER BY setting_key",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([plugin_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?;
    let mut settings = Vec::new();
    let mut bytes = 0_usize;
    for row in rows {
        let (key, raw, updated_at) = row.map_err(storage_error)?;
        if settings.len() == PLUGIN_SETTINGS_KEYS_MAX {
            return Err(RepositoryError::Storage(
                "plugin settings bound exceeded".to_owned(),
            ));
        }
        bytes = bytes.saturating_add(raw.len());
        if bytes > PLUGIN_SETTINGS_BYTES_MAX {
            return Err(RepositoryError::Storage(
                "plugin settings aggregate exceeded".to_owned(),
            ));
        }
        let value: SettingValue = serde_json::from_str(&raw).map_err(storage_error)?;
        if serde_json::to_string(&value).map_err(storage_error)? != raw {
            return Err(RepositoryError::Storage(
                "plugin setting is not canonical".to_owned(),
            ));
        }
        plugin
            .manifest
            .validate_persisted_setting(&key, &value)
            .map_err(storage_error)?;
        settings.push(PluginSetting {
            key: PluginId::parse(key).map_err(storage_error)?,
            value,
            updated_at: parse_timestamp(&updated_at, "setting timestamp")?,
        });
    }
    Ok(settings)
}

fn setting_projection(
    connection: &Connection,
    plugin_id: &PluginId,
    key: &PluginId,
    value_json: Option<&str>,
) -> Result<(usize, usize), RepositoryError> {
    let (count, bytes): (i64, i64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(CAST(value_json AS BLOB))), 0)
             FROM plugin_settings WHERE plugin_id = ?1",
            [plugin_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    let old: Option<i64> = connection
        .query_row(
            "SELECT LENGTH(CAST(value_json AS BLOB))
             FROM plugin_settings WHERE plugin_id = ?1 AND setting_key = ?2",
            params![plugin_id.as_str(), key.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let mut projected_count = usize::try_from(count).map_err(storage_error)?;
    let mut projected_bytes = usize::try_from(bytes).map_err(storage_error)?;
    if let Some(old) = old {
        projected_bytes =
            projected_bytes.saturating_sub(usize::try_from(old).map_err(storage_error)?);
    } else if value_json.is_some() {
        projected_count = projected_count.saturating_add(1);
    }
    if let Some(value) = value_json {
        projected_bytes = projected_bytes.saturating_add(value.len());
    } else if old.is_some() {
        projected_count = projected_count.saturating_sub(1);
    }
    Ok((projected_count, projected_bytes))
}

pub(crate) fn set_plugin_setting(
    connection: &mut Connection,
    operation_id: OperationId,
    request: SetPluginSettingRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::SetSetting { request: &request })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .into_iter()
            .find(|plugin| plugin.plugin_id == request.plugin_id)
            .ok_or(RepositoryError::NotFound)?;
        if plugin.package_generation != request.package_generation {
            return Err(RepositoryError::Conflict);
        }
        plugin
            .manifest
            .validate_persisted_setting(request.key.as_str(), &request.value)
            .map_err(|_| RepositoryError::Conflict)?;
        let raw = serde_json::to_string(&request.value).map_err(storage_error)?;
        let (count, bytes) = setting_projection(tx, &request.plugin_id, &request.key, Some(&raw))?;
        if count > PLUGIN_SETTINGS_KEYS_MAX || bytes > PLUGIN_SETTINGS_BYTES_MAX {
            return Err(RepositoryError::OperationTooLarge);
        }
        next_activation_epoch(plugin.activation_epoch)?;
        tx.execute(
            "INSERT INTO plugin_settings(plugin_id, setting_key, value_json, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(plugin_id, setting_key) DO UPDATE SET
                value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![
                request.plugin_id.as_str(),
                request.key.as_str(),
                raw,
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
        let stored = finish_authority_mutation(tx, &plugin, now)?;
        Ok(plugin_effect(
            EventType::PLUGIN_SETTING_UPDATED,
            Some(&stored),
            vec![request.plugin_id.clone()],
            Some(request.plugin_id.to_string()),
        ))
    })
}

pub(crate) fn delete_plugin_setting(
    connection: &mut Connection,
    operation_id: OperationId,
    request: DeletePluginSettingRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&OperatorRequest::DeleteSetting { request: &request })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .into_iter()
            .find(|plugin| plugin.plugin_id == request.plugin_id)
            .ok_or(RepositoryError::NotFound)?;
        if plugin.package_generation != request.package_generation {
            return Err(RepositoryError::Conflict);
        }
        setting_projection(tx, &request.plugin_id, &request.key, None)?;
        next_activation_epoch(plugin.activation_epoch)?;
        let changed = tx
            .execute(
                "DELETE FROM plugin_settings WHERE plugin_id = ?1 AND setting_key = ?2",
                params![request.plugin_id.as_str(), request.key.as_str()],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(RepositoryError::NotFound);
        }
        let stored = finish_authority_mutation(tx, &plugin, now)?;
        Ok(plugin_effect(
            EventType::PLUGIN_SETTING_DELETED,
            Some(&stored),
            vec![request.plugin_id.clone()],
            Some(request.plugin_id.to_string()),
        ))
    })
}

pub(crate) fn list_plugin_kv(
    connection: &Connection,
    plugin_id: PluginId,
) -> Result<Vec<PluginKvEntry>, RepositoryError> {
    load_installed_plugin(connection, &plugin_id)?;
    let mut statement = connection
        .prepare(
            "SELECT key, value, updated_at FROM plugin_kv
             WHERE plugin_id = ?1 ORDER BY key",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([plugin_id.as_str()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?;
    let mut entries = Vec::new();
    let mut bytes = 0_usize;
    for row in rows {
        let (key, value, updated_at) = row.map_err(storage_error)?;
        if entries.len() == PLUGIN_KV_KEYS_MAX || value.len() > PLUGIN_KV_VALUE_BYTES_MAX {
            return Err(RepositoryError::Storage(
                "plugin KV bound exceeded".to_owned(),
            ));
        }
        bytes = bytes.saturating_add(value.len());
        if bytes > PLUGIN_KV_BYTES_MAX {
            return Err(RepositoryError::Storage(
                "plugin KV aggregate exceeded".to_owned(),
            ));
        }
        if !valid_kv_key(&key) {
            return Err(RepositoryError::Storage("invalid plugin KV key".to_owned()));
        }
        entries.push(PluginKvEntry {
            key,
            value,
            updated_at: parse_timestamp(&updated_at, "KV timestamp")?,
        });
    }
    Ok(entries)
}

fn valid_kv_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn validate_kv_patch(patch: &PluginKvPatch) -> Result<(), RepositoryError> {
    if patch.set.len().saturating_add(patch.delete.len()) > PLUGIN_KV_KEYS_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    let mut previous = None;
    for (key, value) in &patch.set {
        if previous.is_some_and(|old: &String| old >= key)
            || !valid_kv_key(key)
            || value.len() > PLUGIN_KV_VALUE_BYTES_MAX
        {
            return Err(RepositoryError::OperationTooLarge);
        }
        previous = Some(key);
    }
    previous = None;
    for key in &patch.delete {
        if previous.is_some_and(|old: &String| old >= key)
            || !valid_kv_key(key)
            || patch
                .set
                .binary_search_by(|(set_key, _)| set_key.cmp(key))
                .is_ok()
        {
            return Err(RepositoryError::Conflict);
        }
        previous = Some(key);
    }
    Ok(())
}

fn has_capability(
    connection: &Connection,
    plugin: &InstalledPlugin,
    capability: Capability,
) -> Result<bool, RepositoryError> {
    Ok(list_plugin_grants(connection, plugin.plugin_id.clone())?
        .iter()
        .any(|grant| grant.permission.capability == capability))
}

fn validate_kv_replacement(entries: &[(String, Vec<u8>)]) -> Result<(), RepositoryError> {
    if entries.len() > PLUGIN_KV_KEYS_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    let mut previous = None;
    let mut bytes = 0_usize;
    for (key, value) in entries {
        bytes = bytes.saturating_add(value.len());
        if previous.is_some_and(|old: &String| old >= key)
            || !valid_kv_key(key)
            || value.len() > PLUGIN_KV_VALUE_BYTES_MAX
            || bytes > PLUGIN_KV_BYTES_MAX
        {
            return Err(RepositoryError::OperationTooLarge);
        }
        previous = Some(key);
    }
    Ok(())
}

fn apply_kv_patch(
    connection: &Connection,
    plugin: &InstalledPlugin,
    patch: &PluginKvPatch,
    now: Timestamp,
) -> Result<Vec<PluginKvEntry>, RepositoryError> {
    validate_kv_patch(patch)?;
    let current = list_plugin_kv(connection, plugin.plugin_id.clone())?;
    let mut projected: BTreeMap<String, Vec<u8>> = current
        .into_iter()
        .map(|entry| (entry.key, entry.value))
        .collect();
    for key in &patch.delete {
        projected.remove(key);
    }
    for (key, value) in &patch.set {
        projected.insert(key.clone(), value.clone());
    }
    let bytes = projected
        .values()
        .fold(0_usize, |total, value| total.saturating_add(value.len()));
    if projected.len() > PLUGIN_KV_KEYS_MAX || bytes > PLUGIN_KV_BYTES_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    for key in &patch.delete {
        connection
            .execute(
                "DELETE FROM plugin_kv WHERE plugin_id = ?1 AND key = ?2",
                params![plugin.plugin_id.as_str(), key.as_str()],
            )
            .map_err(storage_error)?;
    }
    for (key, value) in &patch.set {
        connection
            .execute(
                "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(plugin_id, key) DO UPDATE SET
                    value = excluded.value, updated_at = excluded.updated_at",
                params![
                    plugin.plugin_id.as_str(),
                    key.as_str(),
                    value,
                    now.to_string(),
                ],
            )
            .map_err(storage_error)?;
    }
    list_plugin_kv(connection, plugin.plugin_id.clone())
}

fn apply_kv_replacement(
    connection: &Connection,
    plugin: &InstalledPlugin,
    entries: &[(String, Vec<u8>)],
    now: Timestamp,
) -> Result<Vec<PluginKvEntry>, RepositoryError> {
    validate_kv_replacement(entries)?;
    connection
        .execute(
            "DELETE FROM plugin_kv WHERE plugin_id = ?1",
            [plugin.plugin_id.as_str()],
        )
        .map_err(storage_error)?;
    for (key, value) in entries {
        connection
            .execute(
                "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![plugin.plugin_id.as_str(), key, value, now.to_string()],
            )
            .map_err(storage_error)?;
    }
    list_plugin_kv(connection, plugin.plugin_id.clone())
}

pub(crate) fn patch_plugin_kv(
    connection: &mut Connection,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    patch: PluginKvPatch,
    now: Timestamp,
) -> Result<Vec<PluginKvEntry>, RepositoryError> {
    validate_kv_patch(&patch)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let plugin = load_installed_plugin(&transaction, &plugin_id)?;
    if plugin.package_generation != package_generation
        || plugin.activation_epoch != activation_epoch
        || !plugin.desired_enabled
        || plugin.runtime_state != PluginRuntimeState::Active
        || !has_capability(&transaction, &plugin, Capability::Storage)?
    {
        return Err(RepositoryError::Conflict);
    }
    let result = apply_kv_patch(&transaction, &plugin, &patch, now)?;
    transaction.commit().map_err(storage_error)?;
    Ok(result)
}

fn load_plugin_cursor(
    connection: &Connection,
    plugin_id: &PluginId,
) -> Result<PluginEventCursor, RepositoryError> {
    connection
        .query_row(
            "SELECT event_epoch, revision, resync_required, updated_at
             FROM plugin_event_cursors WHERE plugin_id = ?1",
            [plugin_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::NotFound)
        .and_then(|(event_epoch, revision, resync_required, updated_at)| {
            Ok(PluginEventCursor {
                plugin_id: plugin_id.clone(),
                event_epoch,
                revision: parse_u64(revision, "cursor revision")?,
                resync_required: resync_required == 1,
                updated_at: parse_timestamp(&updated_at, "cursor timestamp")?,
            })
        })
}

pub(crate) fn get_plugin_cursor(
    connection: &Connection,
    plugin_id: PluginId,
) -> Result<PluginEventCursor, RepositoryError> {
    load_installed_plugin(connection, &plugin_id)?;
    load_plugin_cursor(connection, &plugin_id)
}

pub(crate) fn open_plugin_resync_session(
    connection: &mut Connection,
    request: BeginPluginResyncRequest,
    now: Timestamp,
) -> Result<PluginResyncSession, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(storage_error)?;
    let plugin = load_installed_plugin(&transaction, &request.plugin_id)?;
    let cursor = load_plugin_cursor(&transaction, &request.plugin_id)?;
    let (event_epoch, head): (String, i64) = transaction
        .query_row(
            "SELECT event_epoch, global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    if plugin.package_generation != request.package_generation
        || plugin.activation_epoch != request.activation_epoch
        || !plugin.desired_enabled
        || plugin.runtime_state != PluginRuntimeState::Starting
        || !cursor.resync_required
        || cursor.event_epoch != event_epoch
        || now < plugin.updated_at
    {
        return Err(RepositoryError::Conflict);
    }
    let session = PluginResyncSession {
        operation_id: request.operation_id,
        plugin_id: request.plugin_id,
        package_generation: request.package_generation,
        activation_epoch: request.activation_epoch,
        expected_cursor: PluginCursorPosition::from(&cursor),
        snapshot_event_epoch: event_epoch,
        snapshot_revision: parse_u64(head, "resync head revision")?,
    };
    transaction.commit().map_err(storage_error)?;
    Ok(session)
}

fn validate_resync_session(
    connection: &Connection,
    session: &PluginResyncSession,
    now: Timestamp,
) -> Result<InstalledPlugin, RepositoryError> {
    let plugin = load_installed_plugin(connection, &session.plugin_id)?;
    let cursor = load_plugin_cursor(connection, &session.plugin_id)?;
    let (event_epoch, head, earliest): (String, i64, Option<i64>) = connection
        .query_row(
            "SELECT event_epoch, global_revision, (SELECT MIN(revision) FROM events)
             FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(storage_error)?;
    let head = parse_u64(head, "resync current revision")?;
    if plugin.package_generation != session.package_generation
        || plugin.activation_epoch != session.activation_epoch
        || !plugin.desired_enabled
        || plugin.runtime_state != PluginRuntimeState::Starting
        || now < plugin.updated_at
        || !session.expected_cursor.resync_required
        || !cursor_matches(&cursor, &session.expected_cursor)
        || event_epoch != session.snapshot_event_epoch
        || session.snapshot_revision > head
    {
        return Err(RepositoryError::Conflict);
    }
    if session.snapshot_revision < head {
        let required = session
            .snapshot_revision
            .checked_add(1)
            .ok_or_else(|| RepositoryError::Storage("resync revision overflow".to_owned()))?;
        if earliest
            .and_then(|revision| u64::try_from(revision).ok())
            .is_none_or(|revision| revision > required)
        {
            return Err(RepositoryError::Conflict);
        }
    }
    Ok(plugin)
}

fn validate_resync_after_id(
    kind: PluginSnapshotKind,
    after_id: Option<&str>,
) -> Result<&str, RepositoryError> {
    let Some(after_id) = after_id else {
        return Ok("");
    };
    match kind {
        PluginSnapshotKind::Task => TaskId::parse(after_id).map(|_| ()),
        PluginSnapshotKind::Project => ProjectId::parse(after_id).map(|_| ()),
        PluginSnapshotKind::Tag => TagId::parse(after_id).map(|_| ()),
    }
    .map_err(storage_error)?;
    Ok(after_id)
}

fn load_resync_candidate_ids(
    connection: &Connection,
    kind: PluginSnapshotKind,
    after_id: &str,
    snapshot_revision: u64,
) -> Result<Vec<String>, RepositoryError> {
    let revision = as_i64(snapshot_revision, "resync snapshot revision")?;
    let limit = i64::try_from(PLUGIN_RESYNC_PAGE_ITEMS_MAX + 1).map_err(storage_error)?;
    let sql = match kind {
        PluginSnapshotKind::Task => {
            "SELECT id FROM tasks
             WHERE id > ?1 AND revision <= ?2
             ORDER BY id LIMIT ?3"
        }
        PluginSnapshotKind::Project => {
            "SELECT resource.id FROM projects AS resource
             WHERE resource.id > ?1 AND NOT EXISTS(
                 SELECT 1 FROM events AS event
                 WHERE event.revision > ?2 AND (
                     (json_extract(event.event_json, '$.primary.resource_type') = 'project'
                      AND json_extract(event.event_json, '$.primary.id') = resource.id)
                     OR EXISTS(
                         SELECT 1 FROM json_each(event.event_json, '$.affected.project_ids')
                         WHERE value = resource.id
                     )
                 )
             ) ORDER BY resource.id LIMIT ?3"
        }
        PluginSnapshotKind::Tag => {
            "SELECT resource.id FROM tags AS resource
             WHERE resource.id > ?1 AND NOT EXISTS(
                 SELECT 1 FROM events AS event
                 WHERE event.revision > ?2 AND (
                     (json_extract(event.event_json, '$.primary.resource_type') = 'tag'
                      AND json_extract(event.event_json, '$.primary.id') = resource.id)
                     OR EXISTS(
                         SELECT 1 FROM json_each(event.event_json, '$.affected.tag_ids')
                         WHERE value = resource.id
                     )
                 )
             ) ORDER BY resource.id LIMIT ?3"
        }
    };
    let mut statement = connection.prepare(sql).map_err(storage_error)?;
    let rows = statement
        .query_map(params![after_id, revision, limit], |row| {
            row.get::<_, String>(0)
        })
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn load_resync_item(
    connection: &Connection,
    kind: PluginSnapshotKind,
    id: &str,
) -> Result<PluginSnapshotItem, RepositoryError> {
    match kind {
        PluginSnapshotKind::Task => TaskId::parse(id)
            .map_err(storage_error)
            .and_then(|id| load_task(connection, id))
            .map(Box::new)
            .map(PluginSnapshotItem::Task),
        PluginSnapshotKind::Project => ProjectId::parse(id)
            .map_err(storage_error)
            .and_then(|id| load_project(connection, id))
            .map(PluginSnapshotItem::Project),
        PluginSnapshotKind::Tag => TagId::parse(id)
            .map_err(storage_error)
            .and_then(|id| load_tag(connection, id))
            .map(PluginSnapshotItem::Tag),
    }
}

pub(crate) fn list_plugin_resync_page(
    connection: &mut Connection,
    request: PluginResyncPageRequest,
    now: Timestamp,
) -> Result<PluginResyncPage, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Deferred)
        .map_err(storage_error)?;
    let plugin = validate_resync_session(&transaction, &request.session, now)?;
    let after_id = validate_resync_after_id(request.kind, request.after_id.as_deref())?;
    let required_capability = match request.kind {
        PluginSnapshotKind::Task => Capability::TasksRead,
        PluginSnapshotKind::Project => Capability::ProjectsRead,
        PluginSnapshotKind::Tag => Capability::TagsRead,
    };
    let candidate_ids = if has_capability(&transaction, &plugin, required_capability)? {
        load_resync_candidate_ids(
            &transaction,
            request.kind,
            after_id,
            request.session.snapshot_revision,
        )?
    } else {
        Vec::new()
    };
    let mut items = Vec::new();
    let mut item_material = 0_usize;
    let item_material_limit = PLUGIN_RESYNC_PAGE_BYTES_MAX
        .checked_sub(4 * 1024)
        .ok_or_else(|| RepositoryError::Storage("invalid resync page bound".to_owned()))?;
    for id in candidate_ids.iter().take(PLUGIN_RESYNC_PAGE_ITEMS_MAX) {
        let item = load_resync_item(&transaction, request.kind, id)?;
        let bytes = serde_json::to_vec(&item).map_err(storage_error)?.len();
        let projected = item_material.saturating_add(bytes).saturating_add(1);
        if projected > item_material_limit {
            if items.is_empty() {
                return Err(RepositoryError::OperationTooLarge);
            }
            break;
        }
        item_material = projected;
        items.push(item);
    }
    let consumed_all_candidates = items.len() == candidate_ids.len();
    let exhausted = consumed_all_candidates && candidate_ids.len() <= PLUGIN_RESYNC_PAGE_ITEMS_MAX;
    let next_after_id = items.last().map(PluginSnapshotItem::id);
    let mut page = PluginResyncPage {
        operation_id: request.session.operation_id,
        kind: request.kind,
        items,
        next_after_id,
        exhausted,
        material_bytes: 0,
    };
    for _ in 0..3 {
        page.material_bytes = serde_json::to_vec(&page).map_err(storage_error)?.len();
    }
    if page.material_bytes > PLUGIN_RESYNC_PAGE_BYTES_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    transaction.commit().map_err(storage_error)?;
    Ok(page)
}

pub(crate) fn finalize_plugin_resync(
    connection: &mut Connection,
    request: FinalizePluginResyncRequest,
    now: Timestamp,
) -> Result<FinalizePluginResyncOutcome, RepositoryError> {
    finalize_plugin_resync_with(connection, request, now, || Ok(()), || Ok(()))
}

fn finalize_plugin_resync_with(
    connection: &mut Connection,
    request: FinalizePluginResyncRequest,
    now: Timestamp,
    before_commit: impl FnOnce() -> Result<(), RepositoryError>,
    after_commit: impl FnOnce() -> Result<(), RepositoryError>,
) -> Result<FinalizePluginResyncOutcome, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    request
        .transcript
        .validate(&request.delivery, &request.session)?;
    let plugin = load_installed_plugin(&transaction, &request.session.plugin_id)?;
    let invocation = load_invocation(&transaction, request.session.operation_id)?;
    let cursor = load_plugin_cursor(&transaction, &request.session.plugin_id)?;
    let entry_authority = plugin_manifest_entry_authority(
        &plugin.manifest,
        invocation.hook_kind,
        PluginManifestEntrySelector::Requested(&invocation.entry),
    )
    .ok_or(RepositoryError::Conflict)?;
    verify_delivery(
        &transaction,
        &request.delivery,
        &invocation,
        &entry_authority.persisted_id,
    )?;
    let (event_epoch, current_head, earliest): (String, i64, Option<i64>) = transaction
        .query_row(
            "SELECT event_epoch, global_revision, (SELECT MIN(revision) FROM events)
             FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(storage_error)?;
    let current_head = parse_u64(current_head, "resync final head")?;
    if invocation.hook_kind != PluginHookKind::Resync
        || invocation.state != PluginInvocationState::EffectCommitting
        || request.delivery.authority.mode != PluginDeliveryMode::StartingResync
        || request.delivery.retained_event_source().is_some()
        || plugin.package_generation != request.session.package_generation
        || plugin.activation_epoch != request.session.activation_epoch
        || !plugin.desired_enabled
        || plugin.runtime_state != PluginRuntimeState::Starting
        || now < plugin.updated_at
        || now < invocation.updated_at
        || invocation.retain_until <= now
        || request.session.snapshot_revision > current_head
        || !cursor_matches(&cursor, &request.session.expected_cursor)
        || !cursor.resync_required
        || has_other_active_invocation(
            &transaction,
            &request.session.plugin_id,
            Some(request.session.operation_id),
        )?
    {
        return Err(RepositoryError::Conflict);
    }
    match (
        request.transcript.choice(),
        request.transcript.replacement(),
    ) {
        (junban_plugin_sdk::private_body_types::FinalKvChoice::LeaveKv, None) => {}
        (
            junban_plugin_sdk::private_body_types::FinalKvChoice::ReplaceKvWithStagedSegments,
            Some(replacement),
        ) => {
            validate_kv_replacement(replacement)?;
            if !has_capability(&transaction, &plugin, Capability::Storage)? {
                return Err(RepositoryError::Conflict);
            }
        }
        _ => return Err(RepositoryError::Conflict),
    }

    let tail_length = current_head
        .checked_sub(request.session.snapshot_revision)
        .ok_or(RepositoryError::Conflict)?;
    let retained_tail_max =
        u64::try_from(EVENT_RETAIN_MAX_COUNT).map_err(|_| RepositoryError::OperationTooLarge)?;
    let mut restart_required = request.session.expected_cursor.event_epoch != event_epoch
        || request.session.snapshot_event_epoch != event_epoch
        || tail_length > retained_tail_max;
    if !restart_required && request.session.snapshot_revision < current_head {
        let required = request
            .session
            .snapshot_revision
            .checked_add(1)
            .ok_or_else(|| RepositoryError::Storage("resync revision overflow".to_owned()))?;
        if earliest
            .and_then(|revision| u64::try_from(revision).ok())
            .is_none_or(|revision| revision > required)
        {
            restart_required = true;
        } else {
            let mut revision = required;
            while revision <= current_head {
                let classification =
                    load_exact_retained_event(&transaction, revision).and_then(|event| {
                        classify_plugin_resync_event(
                            &event_epoch,
                            &event,
                            &plugin.manifest.subscriptions,
                        )
                        .map_err(|_| RepositoryError::Conflict)
                    });
                match classification {
                    Ok(PluginResyncEvent::Represented(_) | PluginResyncEvent::Irrelevant) => {}
                    Ok(PluginResyncEvent::Invalidating) | Err(_) => {
                        restart_required = true;
                        break;
                    }
                }
                revision = revision.checked_add(1).ok_or_else(|| {
                    RepositoryError::Storage("resync revision overflow".to_owned())
                })?;
            }
        }
    }

    if restart_required {
        let deleted = transaction
            .execute(
                "DELETE FROM plugin_invocations WHERE operation_id = ?1
                   AND plugin_id = ?2 AND package_generation = ?3
                   AND activation_epoch = ?4 AND hook_kind = 'resync'
                   AND request_hash = ?5 AND state = 'effect_committing'",
                params![
                    request.session.operation_id.to_string(),
                    request.session.plugin_id.as_str(),
                    as_i64(request.session.package_generation, "invocation generation")?,
                    as_i64(request.session.activation_epoch, "invocation epoch")?,
                    request.delivery.request_sha256.as_str(),
                ],
            )
            .map_err(storage_error)?;
        if deleted != 1 {
            return Err(RepositoryError::Conflict);
        }
        before_commit()?;
        transaction.commit().map_err(storage_error)?;
        after_commit()?;
        return Ok(FinalizePluginResyncOutcome::RestartRequired);
    }

    if let Some(replacement) = request.transcript.replacement() {
        apply_kv_replacement(&transaction, &plugin, replacement, now)?;
    }
    let changed = transaction
        .execute(
            "UPDATE plugin_event_cursors
             SET event_epoch = ?2, revision = ?3, resync_required = 0, updated_at = ?4
             WHERE plugin_id = ?1 AND event_epoch = ?5 AND revision = ?6
               AND resync_required = 1",
            params![
                request.session.plugin_id.as_str(),
                request.session.snapshot_event_epoch,
                as_i64(
                    request.session.snapshot_revision,
                    "resync snapshot revision"
                )?,
                now.to_string(),
                request.session.expected_cursor.event_epoch,
                as_i64(request.session.expected_cursor.revision, "cursor revision")?,
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    let deleted = transaction
        .execute(
            "DELETE FROM plugin_invocations WHERE operation_id = ?1
               AND plugin_id = ?2 AND package_generation = ?3
               AND activation_epoch = ?4 AND hook_kind = 'resync'
               AND request_hash = ?5 AND state = 'effect_committing'",
            params![
                request.session.operation_id.to_string(),
                request.session.plugin_id.as_str(),
                as_i64(request.session.package_generation, "invocation generation")?,
                as_i64(request.session.activation_epoch, "invocation epoch")?,
                request.delivery.request_sha256.as_str(),
            ],
        )
        .map_err(storage_error)?;
    if deleted != 1 {
        return Err(RepositoryError::Conflict);
    }
    let committed_cursor = load_plugin_cursor(&transaction, &request.session.plugin_id)?;
    before_commit()?;
    transaction.commit().map_err(storage_error)?;
    after_commit()?;
    Ok(FinalizePluginResyncOutcome::Committed(committed_cursor))
}

fn cursor_matches(cursor: &PluginEventCursor, position: &PluginCursorPosition) -> bool {
    cursor.event_epoch == position.event_epoch
        && cursor.revision == position.revision
        && cursor.resync_required == position.resync_required
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CursorAdvanceValidation {
    Replay,
    Advance,
    RetentionLost,
    ResyncRequired,
}

fn validate_cursor_advance(
    connection: &Connection,
    request: &AdvancePluginCursorRequest,
    allow_resync_finalize: bool,
) -> Result<CursorAdvanceValidation, RepositoryError> {
    let current = load_plugin_cursor(connection, &request.plugin_id)?;
    if cursor_matches(&current, &request.next) {
        return Ok(CursorAdvanceValidation::Replay);
    }
    if current.event_epoch == request.expected.event_epoch
        && current.revision == request.expected.revision
        && current.resync_required
        && !request.expected.resync_required
    {
        return Ok(CursorAdvanceValidation::ResyncRequired);
    }
    if !cursor_matches(&current, &request.expected) {
        return Err(RepositoryError::Conflict);
    }
    let (event_epoch, head): (String, i64) = connection
        .query_row(
            "SELECT event_epoch, global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    let head = parse_u64(head, "global revision")?;
    if request.next.event_epoch != event_epoch
        || request.next.revision < current.revision
        || request.next.revision > head
        || (!current.resync_required
            && request.next.resync_required
            && request.next.revision != current.revision)
        || (current.resync_required && !request.next.resync_required && !allow_resync_finalize)
    {
        return Err(RepositoryError::Conflict);
    }
    if !request.next.resync_required {
        let retained_anchor = if current.resync_required {
            request.next.revision
        } else {
            current.revision
        };
        if retained_anchor < head {
            let earliest_retained: Option<i64> = connection
                .query_row("SELECT MIN(revision) FROM events", [], |row| row.get(0))
                .map_err(storage_error)?;
            let required = retained_anchor
                .checked_add(1)
                .ok_or_else(|| RepositoryError::Storage("cursor revision overflow".to_owned()))?;
            if earliest_retained
                .and_then(|revision| u64::try_from(revision).ok())
                .is_none_or(|revision| revision > required)
            {
                return Ok(CursorAdvanceValidation::RetentionLost);
            }
        }
    }
    Ok(CursorAdvanceValidation::Advance)
}

fn advance_cursor_in_transaction(
    connection: &Connection,
    request: &AdvancePluginCursorRequest,
    now: Timestamp,
    allow_resync_finalize: bool,
    mark_retention_loss: bool,
) -> Result<PluginEventCursor, RepositoryError> {
    match validate_cursor_advance(connection, request, allow_resync_finalize)? {
        CursorAdvanceValidation::Replay => {
            return load_plugin_cursor(connection, &request.plugin_id);
        }
        CursorAdvanceValidation::ResyncRequired if mark_retention_loss => {
            return load_plugin_cursor(connection, &request.plugin_id);
        }
        CursorAdvanceValidation::ResyncRequired => return Err(RepositoryError::Conflict),
        CursorAdvanceValidation::RetentionLost if mark_retention_loss => {
            let changed = connection
                .execute(
                    "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
                     WHERE plugin_id = ?1 AND event_epoch = ?3 AND revision = ?4
                       AND resync_required = 0",
                    params![
                        request.plugin_id.as_str(),
                        now.to_string(),
                        request.expected.event_epoch,
                        as_i64(request.expected.revision, "cursor revision")?,
                    ],
                )
                .map_err(storage_error)?;
            if changed != 1 {
                return Err(RepositoryError::Conflict);
            }
            return load_plugin_cursor(connection, &request.plugin_id);
        }
        CursorAdvanceValidation::RetentionLost => return Err(RepositoryError::Conflict),
        CursorAdvanceValidation::Advance => {}
    }
    let changed = connection
        .execute(
            "UPDATE plugin_event_cursors
             SET event_epoch = ?2, revision = ?3, resync_required = ?4, updated_at = ?5
             WHERE plugin_id = ?1 AND event_epoch = ?6 AND revision = ?7
               AND resync_required = ?8",
            params![
                request.plugin_id.as_str(),
                request.next.event_epoch,
                as_i64(request.next.revision, "cursor revision")?,
                i64::from(request.next.resync_required),
                now.to_string(),
                request.expected.event_epoch,
                as_i64(request.expected.revision, "cursor revision")?,
                i64::from(request.expected.resync_required),
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    load_plugin_cursor(connection, &request.plugin_id)
}

#[cfg(test)]
fn advance_cursor_for_test(
    connection: &mut Connection,
    request: AdvancePluginCursorRequest,
    now: Timestamp,
) -> Result<PluginEventCursor, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let plugin = load_installed_plugin(&transaction, &request.plugin_id)?;
    let current_cursor = load_plugin_cursor(&transaction, &request.plugin_id)?;
    let resync_replay = plugin.runtime_state == PluginRuntimeState::Starting
        && current_cursor.event_epoch == request.expected.event_epoch
        && current_cursor.revision == request.expected.revision
        && current_cursor.resync_required
        && !request.expected.resync_required;
    let replay_epoch = request.activation_epoch.checked_add(1);
    if (!cursor_matches(&current_cursor, &request.next)
        && has_other_active_invocation(&transaction, &request.plugin_id, None)?)
        || plugin.package_generation != request.package_generation
        || (plugin.activation_epoch != request.activation_epoch
            && !(resync_replay && replay_epoch == Some(plugin.activation_epoch)))
        || now < plugin.updated_at
        || !plugin.desired_enabled
        || (plugin.runtime_state != PluginRuntimeState::Active && !resync_replay)
    {
        return Err(RepositoryError::Conflict);
    }
    let cursor = advance_cursor_in_transaction(&transaction, &request, now, false, true)?;
    if cursor.resync_required && !current_cursor.resync_required {
        // Entering resync closes persisted admission before the host samples any
        // snapshot pages. Advance the epoch so delayed callbacks from the stale
        // activation cannot regain authority after resync finishes. External HTTP
        // delivery remains honestly ambiguous under the new fence.
        transaction
            .execute_batch("PRAGMA defer_foreign_keys = ON;")
            .map_err(storage_error)?;
        let activation_epoch = next_activation_epoch(plugin.activation_epoch)?;
        transaction
            .execute(
                "UPDATE plugin_invocations SET state = 'ambiguous_http',
                    error_code = 'http_ambiguous', activation_epoch = ?2
                 WHERE plugin_id = ?1 AND state = 'dispatching_http'",
                params![
                    request.plugin_id.as_str(),
                    as_i64(activation_epoch, "activation epoch")?,
                ],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM plugin_invocations
                 WHERE plugin_id = ?1 AND state IN ('reserved', 'effect_committing')",
                [request.plugin_id.as_str()],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE plugin_invocations SET activation_epoch = ?2
                 WHERE plugin_id = ?1 AND state = 'ambiguous_http'",
                params![
                    request.plugin_id.as_str(),
                    as_i64(activation_epoch, "activation epoch")?,
                ],
            )
            .map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE plugins SET activation_epoch = ?2, runtime_state = 'starting',
                    failure_count = 0, last_error_code = NULL, next_retry_at = NULL,
                    updated_at = ?3 WHERE plugin_id = ?1",
                params![
                    request.plugin_id.as_str(),
                    as_i64(activation_epoch, "activation epoch")?,
                    now.to_string()
                ],
            )
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)?;
    Ok(cursor)
}

const RETENTION_LOSS_RECEIPT_OP: &str = "mark_plugin_retention_loss";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PluginRetentionLossReceiptMode {
    StartingCatchUp,
    Active,
}

impl PluginRetentionLossReceiptMode {
    const fn from_delivery(mode: PluginDeliveryMode) -> Option<Self> {
        match mode {
            PluginDeliveryMode::StartingCatchUp => Some(Self::StartingCatchUp),
            PluginDeliveryMode::Active => Some(Self::Active),
            PluginDeliveryMode::StartingResync => None,
        }
    }

    const fn delivery(self) -> PluginDeliveryMode {
        match self {
            Self::StartingCatchUp => PluginDeliveryMode::StartingCatchUp,
            Self::Active => PluginDeliveryMode::Active,
        }
    }

    const fn runtime_state(self) -> PluginRuntimeState {
        match self {
            Self::StartingCatchUp => PluginRuntimeState::Starting,
            Self::Active => PluginRuntimeState::Active,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginRetentionLossReceiptRequest {
    op: String,
    operation_id: OperationId,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    host_session_sha256: Sha256Digest,
    mode: PluginRetentionLossReceiptMode,
    expected_cursor: PluginCursorPosition,
    request_sha256: Sha256Digest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginCursorRestartPostTransition {
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    desired_enabled: bool,
    runtime_state: PluginRuntimeState,
    failure_count: u32,
    last_error_code: Option<String>,
    next_retry_at: Option<Timestamp>,
    updated_at: Timestamp,
}

impl PluginCursorRestartPostTransition {
    fn from_plugin(plugin: &InstalledPlugin) -> Self {
        Self {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            desired_enabled: plugin.desired_enabled,
            runtime_state: plugin.runtime_state,
            failure_count: plugin.failure_count,
            last_error_code: plugin.last_error_code.clone(),
            next_retry_at: plugin.next_retry_at,
            updated_at: plugin.updated_at,
        }
    }

    fn matches(&self, plugin: &InstalledPlugin) -> bool {
        self == &Self::from_plugin(plugin)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PluginCursorRestartReceiptResponse {
    op: String,
    cursor: PluginEventCursor,
    post_transition: PluginCursorRestartPostTransition,
}

fn retention_loss_receipt_error() -> RepositoryError {
    RepositoryError::Storage("plugin retention-loss receipt authority mismatch".to_owned())
}

fn retention_loss_receipt_request(
    request: &MarkPluginRetentionLossRequest,
) -> Result<PluginRetentionLossReceiptRequest, RepositoryError> {
    request.validate()?;
    let mode = PluginRetentionLossReceiptMode::from_delivery(request.authority.mode)
        .ok_or(RepositoryError::Conflict)?;
    Ok(PluginRetentionLossReceiptRequest {
        op: RETENTION_LOSS_RECEIPT_OP.to_owned(),
        operation_id: request.operation_id,
        plugin_id: request.authority.plugin_id.clone(),
        package_generation: request.authority.package_generation,
        activation_epoch: request.authority.activation_epoch,
        host_session_sha256: request.authority.host_session_sha256(),
        mode,
        expected_cursor: request.expected_cursor.clone(),
        request_sha256: request.digest()?,
    })
}

fn parse_plugin_retention_loss_receipt_request(
    operation_id: OperationId,
    request_json: &str,
) -> Result<PluginRetentionLossReceiptRequest, RepositoryError> {
    let request: PluginRetentionLossReceiptRequest =
        serde_json::from_str(request_json).map_err(|_| retention_loss_receipt_error())?;
    let canonical_epoch = OperationId::parse(&request.expected_cursor.event_epoch)
        .map_err(|_| retention_loss_receipt_error())?;
    let digest = plugin_retention_loss_request_digest(
        request.operation_id,
        &request.plugin_id,
        request.package_generation,
        request.activation_epoch,
        &request.host_session_sha256,
        request.mode.delivery(),
        &request.expected_cursor,
    )
    .map_err(|_| retention_loss_receipt_error())?;
    if canonical_json(&request)? != request_json
        || request.op != RETENTION_LOSS_RECEIPT_OP
        || request.operation_id != operation_id
        || canonical_epoch.to_string() != request.expected_cursor.event_epoch
        || request.request_sha256 != digest
    {
        return Err(retention_loss_receipt_error());
    }
    Ok(request)
}

pub(crate) fn validate_plugin_retention_loss_receipt(
    operation_id: OperationId,
    request_json: &str,
    response_json: &str,
) -> Result<PluginCursorRestartReceiptResponse, RepositoryError> {
    let request = parse_plugin_retention_loss_receipt_request(operation_id, request_json)?;
    let response: PluginCursorRestartReceiptResponse =
        serde_json::from_str(response_json).map_err(|_| retention_loss_receipt_error())?;
    let expected_epoch = request
        .activation_epoch
        .checked_add(1)
        .filter(|epoch| *epoch <= i64::MAX as u64)
        .ok_or_else(retention_loss_receipt_error)?;
    let post = &response.post_transition;
    if canonical_json(&response)? != response_json
        || response.op != RETENTION_LOSS_RECEIPT_OP
        || response.cursor.plugin_id != request.plugin_id
        || response.cursor.event_epoch != request.expected_cursor.event_epoch
        || response.cursor.revision != request.expected_cursor.revision
        || !response.cursor.resync_required
        || post.plugin_id != request.plugin_id
        || post.package_generation != request.package_generation
        || post.activation_epoch != expected_epoch
        || !post.desired_enabled
        || post.runtime_state != PluginRuntimeState::Starting
        || post.failure_count != 0
        || post.last_error_code.is_some()
        || post.next_retry_at.is_some()
        || post.updated_at != response.cursor.updated_at
    {
        return Err(retention_loss_receipt_error());
    }
    Ok(response)
}

pub(crate) fn validate_plugin_retention_loss_receipts(
    connection: &Connection,
) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, request_json, response_json
             FROM operation_receipts ORDER BY operation_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (operation_id, request_json, response_json) = row.map_err(storage_error)?;
        let request_claims_shape = serde_json::from_str::<serde_json::Value>(&request_json)
            .ok()
            .and_then(|value| {
                value
                    .get("op")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some(RETENTION_LOSS_RECEIPT_OP)
            || serde_json::from_str::<PluginRetentionLossReceiptRequest>(&request_json).is_ok();
        let response_has_shape =
            serde_json::from_str::<PluginCursorRestartReceiptResponse>(&response_json)
                .is_ok_and(|response| response.op == RETENTION_LOSS_RECEIPT_OP);
        if request_claims_shape || response_has_shape {
            validate_plugin_retention_loss_receipt(
                OperationId::parse(&operation_id).map_err(storage_error)?,
                &request_json,
                &response_json,
            )?;
        }
    }
    Ok(())
}

fn read_retention_loss_replay(
    connection: &Connection,
    request: &MarkPluginRetentionLossRequest,
    request_json: &str,
) -> Result<Option<PluginEventCursor>, RepositoryError> {
    let receipt = connection
        .query_row(
            "SELECT request_json, response_json FROM operation_receipts WHERE operation_id = ?1",
            [request.operation_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((stored_request, stored_response)) = receipt else {
        return Ok(None);
    };
    if stored_request != request_json {
        return Err(RepositoryError::IdempotencyMismatch);
    }
    let response = validate_plugin_retention_loss_receipt(
        request.operation_id,
        &stored_request,
        &stored_response,
    )?;
    let plugin = load_installed_plugin(connection, &request.authority.plugin_id).map_err(
        |error| match error {
            RepositoryError::NotFound => RepositoryError::Conflict,
            error => error,
        },
    )?;
    let cursor =
        load_plugin_cursor(connection, &request.authority.plugin_id).map_err(
            |error| match error {
                RepositoryError::NotFound => RepositoryError::Conflict,
                error => error,
            },
        )?;
    if !response.post_transition.matches(&plugin) || cursor != response.cursor {
        return Err(RepositoryError::Conflict);
    }
    Ok(Some(response.cursor))
}

pub(crate) fn mark_plugin_retention_loss(
    connection: &mut Connection,
    request: MarkPluginRetentionLossRequest,
    now: Timestamp,
) -> Result<PluginEventCursor, RepositoryError> {
    request.validate()?;
    let receipt_request = retention_loss_receipt_request(&request)?;
    let request_json = canonical_json(&receipt_request)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON")
        .map_err(storage_error)?;
    if let Some(cursor) = read_retention_loss_replay(&transaction, &request, &request_json)? {
        transaction.commit().map_err(storage_error)?;
        return Ok(cursor);
    }

    let plugin = load_installed_plugin(&transaction, &request.authority.plugin_id)?;
    let cursor = load_plugin_cursor(&transaction, &request.authority.plugin_id)?;
    let mode = PluginRetentionLossReceiptMode::from_delivery(request.authority.mode)
        .ok_or(RepositoryError::Conflict)?;
    if plugin.package_generation != request.authority.package_generation
        || plugin.activation_epoch != request.authority.activation_epoch
        || !plugin.desired_enabled
        || plugin.runtime_state != mode.runtime_state()
        || now < plugin.updated_at
        || now < cursor.updated_at
        || !cursor_matches(&cursor, &request.expected_cursor)
        || cursor.resync_required
    {
        return Err(RepositoryError::Conflict);
    }

    let (event_epoch, head, earliest_retained): (String, i64, Option<i64>) = transaction
        .query_row(
            "SELECT event_epoch, global_revision, (SELECT MIN(revision) FROM events)
             FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(storage_error)?;
    let head = parse_u64(head, "global revision")?;
    let required_revision = cursor
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= i64::MAX as u64)
        .ok_or(RepositoryError::Conflict)?;
    let required_is_retained: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE revision = ?1)",
            [as_i64(required_revision, "required retained revision")?],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let earliest_retained = earliest_retained
        .map(|revision| parse_u64(revision, "earliest retained revision"))
        .transpose()?;
    if event_epoch != request.expected_cursor.event_epoch
        || cursor.revision >= head
        || required_is_retained
        || earliest_retained.is_some_and(|earliest| earliest <= required_revision)
    {
        return Err(RepositoryError::Conflict);
    }
    let (committed_cursor, committed_plugin) = restart_plugin_cursor_for_resync(
        &transaction,
        &plugin,
        &request.expected_cursor,
        mode.runtime_state(),
        now,
    )?;
    let response = PluginCursorRestartReceiptResponse {
        op: RETENTION_LOSS_RECEIPT_OP.to_owned(),
        cursor: committed_cursor.clone(),
        post_transition: PluginCursorRestartPostTransition::from_plugin(&committed_plugin),
    };
    let response_json = canonical_json(&response)?;
    validate_plugin_retention_loss_receipt(request.operation_id, &request_json, &response_json)?;
    write_receipt_response_in_transaction(
        &transaction,
        request.operation_id,
        &request_json,
        &response_json,
        now,
    )?;
    transaction.commit().map_err(storage_error)?;
    Ok(committed_cursor)
}

const INVALIDATING_EVENT_RECEIPT_OP: &str = "mark_plugin_invalidating_event";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginInvalidatingEventReceiptRequest {
    op: String,
    operation_id: OperationId,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    host_session_sha256: Sha256Digest,
    mode: PluginRetentionLossReceiptMode,
    expected_cursor: PluginCursorPosition,
    source_revision: u64,
    event_content_sha256: Sha256Digest,
    request_sha256: Sha256Digest,
}

fn invalidating_event_receipt_error() -> RepositoryError {
    RepositoryError::Storage("plugin invalidating-event receipt authority mismatch".to_owned())
}

fn invalidating_event_receipt_request(
    request: &MarkPluginInvalidatingEventRequest,
) -> Result<PluginInvalidatingEventReceiptRequest, RepositoryError> {
    request.validate()?;
    let mode = PluginRetentionLossReceiptMode::from_delivery(request.authority.mode)
        .ok_or(RepositoryError::Conflict)?;
    Ok(PluginInvalidatingEventReceiptRequest {
        op: INVALIDATING_EVENT_RECEIPT_OP.to_owned(),
        operation_id: request.operation_id,
        plugin_id: request.authority.plugin_id.clone(),
        package_generation: request.authority.package_generation,
        activation_epoch: request.authority.activation_epoch,
        host_session_sha256: request.authority.host_session_sha256(),
        mode,
        expected_cursor: request.expected_cursor.clone(),
        source_revision: request.source_revision,
        event_content_sha256: request.event_content_sha256.clone(),
        request_sha256: request.digest()?,
    })
}

fn parse_plugin_invalidating_event_receipt_request(
    operation_id: OperationId,
    request_json: &str,
) -> Result<PluginInvalidatingEventReceiptRequest, RepositoryError> {
    let request: PluginInvalidatingEventReceiptRequest =
        serde_json::from_str(request_json).map_err(|_| invalidating_event_receipt_error())?;
    let canonical_epoch = OperationId::parse(&request.expected_cursor.event_epoch)
        .map_err(|_| invalidating_event_receipt_error())?;
    let digest = plugin_invalidating_event_request_digest(
        request.operation_id,
        &request.plugin_id,
        request.package_generation,
        request.activation_epoch,
        &request.host_session_sha256,
        request.mode.delivery(),
        &request.expected_cursor,
        request.source_revision,
        &request.event_content_sha256,
    )
    .map_err(|_| invalidating_event_receipt_error())?;
    if canonical_json(&request)? != request_json
        || request.op != INVALIDATING_EVENT_RECEIPT_OP
        || request.operation_id != operation_id
        || canonical_epoch.to_string() != request.expected_cursor.event_epoch
        || request.request_sha256 != digest
    {
        return Err(invalidating_event_receipt_error());
    }
    Ok(request)
}

pub(crate) fn validate_plugin_invalidating_event_receipt(
    operation_id: OperationId,
    request_json: &str,
    response_json: &str,
) -> Result<PluginCursorRestartReceiptResponse, RepositoryError> {
    let request = parse_plugin_invalidating_event_receipt_request(operation_id, request_json)?;
    let response: PluginCursorRestartReceiptResponse =
        serde_json::from_str(response_json).map_err(|_| invalidating_event_receipt_error())?;
    let expected_epoch = request
        .activation_epoch
        .checked_add(1)
        .filter(|epoch| *epoch <= i64::MAX as u64)
        .ok_or_else(invalidating_event_receipt_error)?;
    let post = &response.post_transition;
    if canonical_json(&response)? != response_json
        || response.op != INVALIDATING_EVENT_RECEIPT_OP
        || response.cursor.plugin_id != request.plugin_id
        || response.cursor.event_epoch != request.expected_cursor.event_epoch
        || response.cursor.revision != request.expected_cursor.revision
        || !response.cursor.resync_required
        || post.plugin_id != request.plugin_id
        || post.package_generation != request.package_generation
        || post.activation_epoch != expected_epoch
        || !post.desired_enabled
        || post.runtime_state != PluginRuntimeState::Starting
        || post.failure_count != 0
        || post.last_error_code.is_some()
        || post.next_retry_at.is_some()
        || post.updated_at != response.cursor.updated_at
    {
        return Err(invalidating_event_receipt_error());
    }
    Ok(response)
}

pub(crate) fn validate_plugin_invalidating_event_receipts(
    connection: &Connection,
) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, request_json, response_json
             FROM operation_receipts ORDER BY operation_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (operation_id, request_json, response_json) = row.map_err(storage_error)?;
        let request_claims_shape = serde_json::from_str::<serde_json::Value>(&request_json)
            .ok()
            .and_then(|value| {
                value
                    .get("op")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some(INVALIDATING_EVENT_RECEIPT_OP)
            || serde_json::from_str::<PluginInvalidatingEventReceiptRequest>(&request_json).is_ok();
        let response_has_shape =
            serde_json::from_str::<PluginCursorRestartReceiptResponse>(&response_json)
                .is_ok_and(|response| response.op == INVALIDATING_EVENT_RECEIPT_OP);
        if request_claims_shape || response_has_shape {
            validate_plugin_invalidating_event_receipt(
                OperationId::parse(&operation_id).map_err(storage_error)?,
                &request_json,
                &response_json,
            )?;
        }
    }
    Ok(())
}

fn read_invalidating_event_replay(
    connection: &Connection,
    request: &MarkPluginInvalidatingEventRequest,
    request_json: &str,
) -> Result<Option<PluginEventCursor>, RepositoryError> {
    let receipt = connection
        .query_row(
            "SELECT request_json, response_json FROM operation_receipts WHERE operation_id = ?1",
            [request.operation_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((stored_request, stored_response)) = receipt else {
        return Ok(None);
    };
    if stored_request != request_json {
        return Err(RepositoryError::IdempotencyMismatch);
    }
    let response = validate_plugin_invalidating_event_receipt(
        request.operation_id,
        &stored_request,
        &stored_response,
    )?;
    let plugin = load_installed_plugin(connection, &request.authority.plugin_id).map_err(
        |error| match error {
            RepositoryError::NotFound => RepositoryError::Conflict,
            error => error,
        },
    )?;
    let cursor =
        load_plugin_cursor(connection, &request.authority.plugin_id).map_err(
            |error| match error {
                RepositoryError::NotFound => RepositoryError::Conflict,
                error => error,
            },
        )?;
    if !response.post_transition.matches(&plugin) || cursor != response.cursor {
        return Err(RepositoryError::Conflict);
    }
    Ok(Some(response.cursor))
}

pub(crate) fn mark_plugin_invalidating_event(
    connection: &mut Connection,
    request: MarkPluginInvalidatingEventRequest,
    now: Timestamp,
) -> Result<PluginEventCursor, RepositoryError> {
    request.validate()?;
    let receipt_request = invalidating_event_receipt_request(&request)?;
    let request_json = canonical_json(&receipt_request)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON")
        .map_err(storage_error)?;
    if let Some(cursor) = read_invalidating_event_replay(&transaction, &request, &request_json)? {
        transaction.commit().map_err(storage_error)?;
        return Ok(cursor);
    }

    let plugin = load_installed_plugin(&transaction, &request.authority.plugin_id)?;
    let cursor = load_plugin_cursor(&transaction, &request.authority.plugin_id)?;
    let mode = PluginRetentionLossReceiptMode::from_delivery(request.authority.mode)
        .ok_or(RepositoryError::Conflict)?;
    if plugin.package_generation != request.authority.package_generation
        || plugin.activation_epoch != request.authority.activation_epoch
        || !plugin.desired_enabled
        || plugin.runtime_state != mode.runtime_state()
        || now < plugin.updated_at
        || now < cursor.updated_at
        || !cursor_matches(&cursor, &request.expected_cursor)
        || cursor.resync_required
    {
        return Err(RepositoryError::Conflict);
    }
    let event_epoch: String = transaction
        .query_row(
            "SELECT event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let retained_event_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM events WHERE revision = ?1)",
            [revision_to_i64(request.source_revision)?],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if !retained_event_exists {
        return Err(RepositoryError::NotFound);
    }
    let event = load_exact_retained_event(&transaction, request.source_revision)?;
    let content_hash = plugin_committed_event_content_hash(&event)?;
    let invalidating = match request.authority.mode {
        PluginDeliveryMode::StartingCatchUp => matches!(
            classify_plugin_resync_event(
                &request.expected_cursor.event_epoch,
                &event,
                &plugin.manifest.subscriptions,
            ),
            Ok(PluginResyncEvent::Invalidating) | Err(_)
        ),
        PluginDeliveryMode::Active => convert_active_plugin_event(
            &request.expected_cursor.event_epoch,
            &event,
            &plugin.manifest.subscriptions,
        )
        .is_err(),
        PluginDeliveryMode::StartingResync => false,
    };
    if event_epoch != request.expected_cursor.event_epoch
        || event.revision != request.source_revision
        || content_hash != request.event_content_sha256
        || !invalidating
    {
        return Err(RepositoryError::Conflict);
    }

    let (committed_cursor, committed_plugin) = restart_plugin_cursor_for_resync(
        &transaction,
        &plugin,
        &request.expected_cursor,
        mode.runtime_state(),
        now,
    )?;
    let response = PluginCursorRestartReceiptResponse {
        op: INVALIDATING_EVENT_RECEIPT_OP.to_owned(),
        cursor: committed_cursor.clone(),
        post_transition: PluginCursorRestartPostTransition::from_plugin(&committed_plugin),
    };
    let response_json = canonical_json(&response)?;
    validate_plugin_invalidating_event_receipt(
        request.operation_id,
        &request_json,
        &response_json,
    )?;
    write_receipt_response_in_transaction(
        &transaction,
        request.operation_id,
        &request_json,
        &response_json,
        now,
    )?;
    transaction.commit().map_err(storage_error)?;
    Ok(committed_cursor)
}

fn restart_plugin_cursor_for_resync(
    connection: &Connection,
    plugin: &InstalledPlugin,
    expected_cursor: &PluginCursorPosition,
    expected_runtime_state: PluginRuntimeState,
    now: Timestamp,
) -> Result<(PluginEventCursor, InstalledPlugin), RepositoryError> {
    let new_activation_epoch = plugin
        .activation_epoch
        .checked_add(1)
        .filter(|epoch| *epoch <= i64::MAX as u64)
        .ok_or(RepositoryError::Conflict)?;
    let generation = as_i64(plugin.package_generation, "package generation")?;
    let old_epoch = as_i64(plugin.activation_epoch, "activation epoch")?;
    let new_epoch = as_i64(new_activation_epoch, "activation epoch")?;
    let changed = connection
        .execute(
            "UPDATE plugin_event_cursors
             SET resync_required = 1, updated_at = ?5
             WHERE plugin_id = ?1 AND event_epoch = ?2 AND revision = ?3
               AND resync_required = ?4",
            params![
                plugin.plugin_id.as_str(),
                expected_cursor.event_epoch,
                as_i64(expected_cursor.revision, "cursor revision")?,
                i64::from(expected_cursor.resync_required),
                now.to_string(),
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    connection
        .execute(
            "UPDATE plugin_invocations
             SET state = 'ambiguous_http', error_code = 'http_ambiguous'
             WHERE plugin_id = ?1 AND package_generation = ?2
               AND activation_epoch = ?3 AND state = 'dispatching_http'",
            params![plugin.plugin_id.as_str(), generation, old_epoch],
        )
        .map_err(storage_error)?;
    connection
        .execute(
            "UPDATE plugin_invocations SET activation_epoch = ?4
             WHERE plugin_id = ?1 AND package_generation = ?2
               AND activation_epoch = ?3 AND state = 'ambiguous_http'",
            params![plugin.plugin_id.as_str(), generation, old_epoch, new_epoch],
        )
        .map_err(storage_error)?;
    connection
        .execute(
            "DELETE FROM plugin_invocations
             WHERE plugin_id = ?1 AND package_generation = ?2
               AND activation_epoch = ?3 AND state IN ('reserved', 'effect_committing')",
            params![plugin.plugin_id.as_str(), generation, old_epoch],
        )
        .map_err(storage_error)?;
    let changed = connection
        .execute(
            "UPDATE plugins
             SET activation_epoch = ?4, runtime_state = 'starting', failure_count = 0,
                 last_error_code = NULL, next_retry_at = NULL, updated_at = ?5
             WHERE plugin_id = ?1 AND package_generation = ?2
               AND activation_epoch = ?3 AND desired_enabled = 1
               AND runtime_state = ?6",
            params![
                plugin.plugin_id.as_str(),
                generation,
                old_epoch,
                new_epoch,
                now.to_string(),
                runtime_state_name(expected_runtime_state),
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    Ok((
        load_plugin_cursor(connection, &plugin.plugin_id)?,
        load_installed_plugin(connection, &plugin.plugin_id)?,
    ))
}

fn retained_event_is_invalidating(event: &CommittedEvent) -> bool {
    if !event.affected.task_ids.is_empty()
        || !event.affected.project_ids.is_empty()
        || !event.affected.tag_ids.is_empty()
    {
        return true;
    }
    matches!(
        event.event_type.as_str(),
        EventType::TASK_CREATED
            | EventType::TASK_UPDATED
            | EventType::TASK_COMPLETED
            | EventType::TASK_UNCOMPLETED
            | EventType::TASK_CANCELLED
            | EventType::TASK_REOPENED
            | EventType::TASK_DELETED
            | EventType::TASK_MOVED
            | EventType::TASK_REORDERED
            | EventType::TASK_BULK
            | EventType::TASK_RESTORED
            | EventType::PROJECT_CREATED
            | EventType::PROJECT_UPDATED
            | EventType::PROJECT_DELETED
            | EventType::TAG_CREATED
            | EventType::TAG_UPDATED
            | EventType::TAG_DELETED
            | EventType::SECTION_DELETED
            | EventType::OPERATION_UNDONE
            | EventType::IMPORT_APPLIED
    )
}

pub(crate) fn verified_skip_plugin_cursor(
    connection: &mut Connection,
    request: VerifiedPluginCursorSkipRequest,
    now: Timestamp,
) -> Result<PluginEventCursor, RepositoryError> {
    request.validate()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let plugin = load_installed_plugin(&transaction, &request.authority.plugin_id)?;
    let runtime_admits = match request.authority.mode {
        PluginDeliveryMode::StartingCatchUp => plugin.runtime_state == PluginRuntimeState::Starting,
        PluginDeliveryMode::Active => runtime_admits_ordinary(&plugin, now),
        PluginDeliveryMode::StartingResync => false,
    };
    if plugin.package_generation != request.authority.package_generation
        || plugin.activation_epoch != request.authority.activation_epoch
        || !plugin.desired_enabled
        || now < plugin.updated_at
        || !runtime_admits
        || has_other_active_invocation(&transaction, &plugin.plugin_id, None)?
    {
        return Err(RepositoryError::Conflict);
    }
    let current = PluginCursorPosition::from(&load_plugin_cursor(&transaction, &plugin.plugin_id)?);
    if current != request.expected_cursor {
        return Err(RepositoryError::Conflict);
    }
    let event = load_exact_retained_event(&transaction, request.source_revision)?;
    let content_hash = plugin_committed_event_content_hash(&event)?;
    let subscribed = plugin
        .manifest
        .subscriptions
        .iter()
        .any(|kind| kind.as_str() == event.event_type.as_str());
    if content_hash != request.event_content_sha256
        || subscribed
        || retained_event_is_invalidating(&event)
        || request.classification != PluginRetainedEventClassification::Irrelevant
    {
        return Err(RepositoryError::Conflict);
    }
    let cursor = advance_cursor_in_transaction(
        &transaction,
        &AdvancePluginCursorRequest {
            plugin_id: plugin.plugin_id,
            package_generation: request.authority.package_generation,
            activation_epoch: request.authority.activation_epoch,
            expected: request.expected_cursor,
            next: request.next_cursor,
        },
        now,
        false,
        false,
    )?;
    transaction.commit().map_err(storage_error)?;
    Ok(cursor)
}

fn invocation_state(value: &str) -> Result<PluginInvocationState, RepositoryError> {
    match value {
        "reserved" => Ok(PluginInvocationState::Reserved),
        "dispatching_http" => Ok(PluginInvocationState::DispatchingHttp),
        "effect_committing" => Ok(PluginInvocationState::EffectCommitting),
        "ambiguous_http" => Ok(PluginInvocationState::AmbiguousHttp),
        _ => Err(RepositoryError::Storage(
            "invalid plugin invocation state".to_owned(),
        )),
    }
}

const fn runtime_state_name(value: PluginRuntimeState) -> &'static str {
    match value {
        PluginRuntimeState::Disabled => "disabled",
        PluginRuntimeState::Starting => "starting",
        PluginRuntimeState::Active => "active",
        PluginRuntimeState::Degraded => "degraded",
        PluginRuntimeState::Failed => "failed",
        PluginRuntimeState::Suspended => "suspended",
        PluginRuntimeState::ReverifyRequired => "reverify_required",
    }
}

const fn invocation_state_name(value: PluginInvocationState) -> &'static str {
    match value {
        PluginInvocationState::Reserved => "reserved",
        PluginInvocationState::DispatchingHttp => "dispatching_http",
        PluginInvocationState::EffectCommitting => "effect_committing",
        PluginInvocationState::AmbiguousHttp => "ambiguous_http",
    }
}

fn hook_kind(value: &str) -> Result<PluginHookKind, RepositoryError> {
    match value {
        "invoke_command" => Ok(PluginHookKind::InvokeCommand),
        "handle_event" => Ok(PluginHookKind::HandleEvent),
        "handle_surface_action" => Ok(PluginHookKind::HandleSurfaceAction),
        "resync" => Ok(PluginHookKind::Resync),
        _ => Err(RepositoryError::Storage(
            "invalid plugin invocation hook".to_owned(),
        )),
    }
}

const fn hook_kind_name(value: PluginHookKind) -> &'static str {
    match value {
        PluginHookKind::InvokeCommand => "invoke_command",
        PluginHookKind::HandleEvent => "handle_event",
        PluginHookKind::HandleSurfaceAction => "handle_surface_action",
        PluginHookKind::Resync => "resync",
    }
}

fn load_invocation(
    connection: &Connection,
    operation_id: OperationId,
) -> Result<PluginInvocation, RepositoryError> {
    connection
        .query_row(
            "SELECT plugin_id, package_generation, activation_epoch, hook_kind,
                    entry_id, request_hash, delivery_id, state, error_code,
                    created_at, updated_at, retain_until
             FROM plugin_invocations WHERE operation_id = ?1",
            [operation_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, String>(11)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::NotFound)
        .and_then(
            |(
                plugin_id,
                package_generation,
                activation_epoch,
                hook,
                entry_id,
                request_sha256,
                delivery_operation_id,
                state,
                error_code,
                created_at,
                updated_at,
                retain_until,
            )| {
                if error_code
                    .as_deref()
                    .is_some_and(|code| !crate::plugin_validation::valid_error_code(code))
                {
                    return Err(RepositoryError::Storage(
                        "invalid invocation failure code".to_owned(),
                    ));
                }
                let plugin_id = PluginId::parse(plugin_id).map_err(storage_error)?;
                let hook_kind = hook_kind(&hook)?;
                let persisted_entry = PluginId::parse(entry_id).map_err(storage_error)?;
                let plugin = load_installed_plugin(connection, &plugin_id)?;
                let entry = plugin_manifest_entry_authority(
                    &plugin.manifest,
                    hook_kind,
                    PluginManifestEntrySelector::Persisted(&persisted_entry),
                )
                .ok_or_else(|| {
                    RepositoryError::Storage("invalid plugin invocation entry".to_owned())
                })?
                .entry;
                Ok(PluginInvocation {
                    operation_id,
                    plugin_id,
                    package_generation: parse_u64(package_generation, "invocation generation")?,
                    activation_epoch: parse_u64(activation_epoch, "invocation epoch")?,
                    hook_kind,
                    entry,
                    request_sha256: Sha256Digest::parse(request_sha256).map_err(storage_error)?,
                    delivery_operation_id: OperationId::parse(&delivery_operation_id)
                        .map_err(storage_error)?,
                    state: invocation_state(&state)?,
                    error_code,
                    created_at: parse_timestamp(&created_at, "invocation created timestamp")?,
                    updated_at: parse_timestamp(&updated_at, "invocation updated timestamp")?,
                    retain_until: parse_timestamp(&retain_until, "invocation retention timestamp")?,
                })
            },
        )
}

fn derived_operation_id(domain: &[u8], material: &[u8]) -> OperationId {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(material);
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut encoded = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            encoded.push('-');
        }
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    OperationId::parse(&encoded).expect("derived UUID is a valid operation id")
}

fn resource_health_operation_id(operation_id: OperationId) -> OperationId {
    derived_operation_id(
        b"junban.plugin.resource-health.v1\0",
        operation_id.as_uuid().as_bytes(),
    )
}

#[derive(Serialize)]
struct ResourceHealthReceiptRequest<'a> {
    op: &'static str,
    invocation: &'a ReservePluginInvocationRequest,
}

fn resource_health_request_json(
    request: &ReservePluginInvocationRequest,
) -> Result<String, RepositoryError> {
    canonical_json(&ResourceHealthReceiptRequest {
        op: "suspend_plugin_resource_limit",
        invocation: request,
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InvocationReceiptExecution {
    pub(crate) plugin_id: PluginId,
    pub(crate) package_generation: u64,
    pub(crate) host_session_id: Option<OperationId>,
    pub(crate) activation_epoch: u64,
    pub(crate) hook_kind: PluginHookKind,
    pub(crate) entry: PluginManifestEntry,
    pub(crate) request_sha256: Sha256Digest,
    pub(crate) delivery_operation_id: OperationId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InvocationReceiptRequest {
    pub(crate) op: String,
    pub(crate) stable: PluginOperatorRequestIdentity,
    pub(crate) executed: InvocationReceiptExecution,
}

fn invocation_receipt_request_json(
    operation_id: OperationId,
    payload_sha256: Sha256Digest,
    executed: InvocationReceiptExecution,
) -> Result<String, RepositoryError> {
    let persisted_entry_id = junban_app::plugin_manifest_entry_persisted_id(&executed.entry)
        .ok_or(RepositoryError::Conflict)?;
    let stable = PluginOperatorRequestIdentity::new(
        operation_id,
        executed.plugin_id.clone(),
        executed.hook_kind,
        persisted_entry_id,
        payload_sha256,
    )?;
    canonical_json(&InvocationReceiptRequest {
        op: "plugin_invocation_terminal".to_owned(),
        stable,
        executed,
    })
}

fn reservation_receipt_request_json(
    request: &ReservePluginInvocationRequest,
    delivery: Option<&PluginInvocationDelivery>,
) -> Result<String, RepositoryError> {
    let payload_sha256 = delivery.map_or_else(
        || request.request_sha256.clone(),
        |delivery| delivery.authority.payload_sha256.clone(),
    );
    invocation_receipt_request_json(
        request.operation_id,
        payload_sha256,
        InvocationReceiptExecution {
            plugin_id: request.plugin_id.clone(),
            package_generation: request.package_generation,
            host_session_id: delivery.map(|delivery| delivery.authority.host_session_id),
            activation_epoch: request.activation_epoch,
            hook_kind: request.hook_kind,
            entry: request.entry.clone(),
            request_sha256: request.request_sha256.clone(),
            delivery_operation_id: request.delivery_operation_id,
        },
    )
}

fn stored_invocation_receipt_request_json(
    invocation: &PluginInvocation,
    delivery: Option<&PluginInvocationDelivery>,
) -> Result<String, RepositoryError> {
    let payload_sha256 = delivery.map_or_else(
        || invocation.request_sha256.clone(),
        |delivery| delivery.authority.payload_sha256.clone(),
    );
    invocation_receipt_request_json(
        invocation.operation_id,
        payload_sha256,
        InvocationReceiptExecution {
            plugin_id: invocation.plugin_id.clone(),
            package_generation: invocation.package_generation,
            host_session_id: delivery.map(|delivery| delivery.authority.host_session_id),
            activation_epoch: invocation.activation_epoch,
            hook_kind: invocation.hook_kind,
            entry: invocation.entry.clone(),
            request_sha256: invocation.request_sha256.clone(),
            delivery_operation_id: invocation.delivery_operation_id,
        },
    )
}

pub(crate) fn parse_invocation_receipt_request(
    operation_id: OperationId,
    request_json: &str,
) -> Result<InvocationReceiptRequest, RepositoryError> {
    let request: InvocationReceiptRequest =
        serde_json::from_str(request_json).map_err(storage_error)?;
    let persisted_entry_id = junban_app::plugin_manifest_entry_persisted_id(
        &request.executed.entry,
    )
    .ok_or_else(|| RepositoryError::Storage("invalid invocation receipt entry".to_owned()))?;
    let operator_entry = matches!(
        (request.executed.hook_kind, &request.executed.entry),
        (
            PluginHookKind::InvokeCommand,
            PluginManifestEntry::Command { .. }
        ) | (
            PluginHookKind::HandleSurfaceAction,
            PluginManifestEntry::SurfaceAction { .. }
        )
    );
    let executed_request_valid = match request.executed.host_session_id {
        Some(host_session_id) => {
            let authority = junban_app::PluginDeliveryAuthority {
                plugin_id: request.stable.plugin_id.clone(),
                package_generation: request.executed.package_generation,
                activation_epoch: request.executed.activation_epoch,
                host_session_id,
                invocation_id: operation_id,
                payload_sha256: request.stable.payload_sha256.clone(),
                mode: PluginDeliveryMode::Active,
            };
            plugin_invocation_request_hash(
                request.executed.hook_kind,
                &persisted_entry_id,
                &authority.digest()?,
            )? == request.executed.request_sha256
        }
        None => request.executed.request_sha256 == request.stable.payload_sha256,
    };
    if serde_json::to_string(&request).map_err(storage_error)? != request_json
        || request.op != "plugin_invocation_terminal"
        || request.executed.package_generation == 0
        || request.executed.activation_epoch == 0
        || !operator_entry
        || request.stable.operation_id != operation_id
        || request.stable.plugin_id != request.executed.plugin_id
        || request.stable.hook_kind != request.executed.hook_kind
        || request.stable.persisted_entry_id != persisted_entry_id
        || request.stable.validate().is_err()
        || !executed_request_valid
    {
        return Err(RepositoryError::Storage(
            "plugin invocation receipt request is not canonical".to_owned(),
        ));
    }
    Ok(request)
}

pub(crate) fn plugin_invocation_terminal_shape_is_valid(
    response: &CommittedPluginInvocation,
) -> bool {
    match response.rejection {
        Some(_) => {
            response.terminal_kind == PluginInvocationTerminalKind::DomainEffect
                && response.mutation.is_none()
                && response.cursor.is_none()
        }
        None => {
            (response.terminal_kind == PluginInvocationTerminalKind::DomainEffect)
                == response.mutation.is_some()
        }
    }
}

pub(crate) fn validate_plugin_invocation_receipts(
    connection: &Connection,
) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, request_json, response_json
             FROM operation_receipts ORDER BY operation_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (operation_id, request_json, response_json) = row.map_err(storage_error)?;
        let Ok(response) = serde_json::from_str::<CommittedPluginInvocation>(&response_json) else {
            continue;
        };
        let operation_id = OperationId::parse(&operation_id).map_err(storage_error)?;
        parse_invocation_receipt_request(operation_id, &request_json)?;
        let in_flight: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM plugin_invocations WHERE operation_id = ?1)",
                [operation_id.to_string()],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if serde_json::to_string(&response).map_err(storage_error)? != response_json
            || in_flight
            || response.cursor.is_some()
            || !plugin_invocation_terminal_shape_is_valid(&response)
        {
            return Err(RepositoryError::Storage(
                "plugin invocation terminal receipt is inconsistent".to_owned(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn replay_completed_plugin_operator(
    connection: &mut Connection,
    identity: PluginOperatorRequestIdentity,
    now: Timestamp,
) -> Result<Option<CommittedPluginInvocation>, RepositoryError> {
    identity.validate()?;
    let receipt = connection
        .query_row(
            "SELECT request_json, response_json, expires_at
             FROM operation_receipts WHERE operation_id = ?1",
            [identity.operation_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?;
    let Some((request_json, response_json, expires_at)) = receipt else {
        return Ok(None);
    };
    if expires_at
        .as_deref()
        .map(|expires_at| parse_timestamp(expires_at, "invocation receipt expiry"))
        .transpose()?
        .is_some_and(|expires_at| expires_at <= now)
    {
        return Ok(None);
    }
    let request = parse_invocation_receipt_request(identity.operation_id, &request_json)
        .map_err(|_| RepositoryError::IdempotencyMismatch)?;
    if request.stable != identity {
        return Err(RepositoryError::IdempotencyMismatch);
    }
    let in_flight: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_invocations WHERE operation_id = ?1)",
            [identity.operation_id.to_string()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if in_flight {
        return Ok(None);
    }
    let mut response: CommittedPluginInvocation =
        serde_json::from_str(&response_json).map_err(storage_error)?;
    if serde_json::to_string(&response).map_err(storage_error)? != response_json
        || response.cursor.is_some()
        || !plugin_invocation_terminal_shape_is_valid(&response)
    {
        return Err(RepositoryError::Storage(
            "plugin invocation terminal receipt is inconsistent".to_owned(),
        ));
    }
    response.replayed = true;
    Ok(Some(response))
}

const fn operator_origin(hook: PluginHookKind) -> bool {
    matches!(
        hook,
        PluginHookKind::InvokeCommand | PluginHookKind::HandleSurfaceAction
    )
}

fn invocation_identity_matches(
    invocation: &PluginInvocation,
    request: &ReservePluginInvocationRequest,
) -> bool {
    invocation.operation_id == request.operation_id
        && invocation.plugin_id == request.plugin_id
        && invocation.package_generation == request.package_generation
        && invocation.activation_epoch == request.activation_epoch
        && invocation.hook_kind == request.hook_kind
        && invocation.entry == request.entry
        && invocation.request_sha256 == request.request_sha256
        && invocation.delivery_operation_id == request.delivery_operation_id
}

fn event_kind_matches_entry(kind: &EventKind, entry: &PluginId) -> bool {
    kind.as_str() == entry.as_str()
}

fn hook_capability_granted(
    connection: &Connection,
    plugin: &InstalledPlugin,
    entry: &PluginManifestEntry,
    required: Option<Capability>,
) -> Result<bool, RepositoryError> {
    let PluginManifestEntry::Event { event_id } = entry else {
        return required.map_or(Ok(true), |capability| {
            has_capability(connection, plugin, capability)
        });
    };
    if required != Some(Capability::EventsSubscribe) {
        return Ok(false);
    }
    Ok(list_plugin_grants(connection, plugin.plugin_id.clone())?
        .iter()
        .any(|grant| {
            grant.permission.capability == Capability::EventsSubscribe
                && matches!(
                    &grant.permission.scope,
                    PermissionScope::Events(scope)
                        if scope
                            .event_kinds
                            .iter()
                            .any(|kind| event_kind_matches_entry(kind, event_id))
                )
        }))
}

fn invocation_material_bytes(connection: &Connection) -> Result<i64, RepositoryError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(
                LENGTH(CAST(operation_id AS BLOB)) +
                LENGTH(CAST(plugin_id AS BLOB)) + 16 +
                LENGTH(CAST(hook_kind AS BLOB)) +
                LENGTH(CAST(entry_id AS BLOB)) +
                LENGTH(CAST(request_hash AS BLOB)) +
                LENGTH(CAST(delivery_id AS BLOB)) +
                LENGTH(CAST(state AS BLOB)) +
                COALESCE(LENGTH(CAST(error_code AS BLOB)), 0) +
                LENGTH(CAST(created_at AS BLOB)) +
                LENGTH(CAST(updated_at AS BLOB)) +
                LENGTH(CAST(retain_until AS BLOB))
             ), 0) FROM plugin_invocations",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn has_other_active_invocation(
    connection: &Connection,
    plugin_id: &PluginId,
    except: Option<OperationId>,
) -> Result<bool, RepositoryError> {
    connection
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM plugin_invocations
                WHERE plugin_id = ?1
                  AND state IN ('reserved', 'dispatching_http', 'effect_committing')
                  AND (?2 IS NULL OR operation_id <> ?2)
             )",
            params![plugin_id.as_str(), except.map(|value| value.to_string())],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn runtime_admits_ordinary(plugin: &InstalledPlugin, now: Timestamp) -> bool {
    now >= plugin.updated_at && plugin.runtime_state == PluginRuntimeState::Active
}

fn delivery_runtime_admits(
    plugin: &InstalledPlugin,
    hook: PluginHookKind,
    delivery: Option<&PluginInvocationDelivery>,
    now: Timestamp,
) -> bool {
    let Some(delivery) = delivery else {
        return match hook {
            PluginHookKind::Resync => plugin.runtime_state == PluginRuntimeState::Starting,
            _ => runtime_admits_ordinary(plugin, now),
        };
    };
    match delivery.authority.mode {
        PluginDeliveryMode::StartingResync => {
            hook == PluginHookKind::Resync && plugin.runtime_state == PluginRuntimeState::Starting
        }
        PluginDeliveryMode::StartingCatchUp => {
            hook == PluginHookKind::HandleEvent
                && plugin.runtime_state == PluginRuntimeState::Starting
        }
        PluginDeliveryMode::Active => runtime_admits_ordinary(plugin, now),
    }
}

fn load_exact_retained_event(
    connection: &Connection,
    revision: u64,
) -> Result<CommittedEvent, RepositoryError> {
    let revision_i64 = revision_to_i64(revision)?;
    let row = connection
        .query_row(
            "SELECT revision, event_type, operation_id, event_json, occurred_at
             FROM events WHERE revision = ?1",
            [revision_i64],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(RepositoryError::Conflict)?;
    let event: CommittedEvent = serde_json::from_str(&row.3).map_err(storage_error)?;
    crate::backup_ops::validate_committed_event(&event)?;
    if row.0 != revision_i64
        || event.revision != revision
        || event.event_type.as_str() != row.1
        || event.operation_id.to_string() != row.2
        || event.occurred_at.to_string() != row.4
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(event)
}

fn verify_retained_event_source(
    connection: &Connection,
    delivery: &PluginInvocationDelivery,
) -> Result<(), RepositoryError> {
    let Some(source) = delivery.retained_event_source() else {
        return Ok(());
    };
    let event = load_exact_retained_event(connection, source.source_revision)?;
    let content_hash = plugin_committed_event_content_hash(&event)?;
    let payload_hash = plugin_retained_event_payload_hash(
        &content_hash,
        delivery.persisted_entry_id.as_str(),
        source.private_body(),
    )?;
    let current = PluginCursorPosition::from(&load_plugin_cursor(
        connection,
        &delivery.authority.plugin_id,
    )?);
    let event_epoch: String = connection
        .query_row(
            "SELECT event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if source.event_content_sha256 != content_hash
        || source.source_revision != event.revision
        || delivery.authority.payload_sha256 != payload_hash
        || current != source.expected_cursor
        || source.next_cursor.event_epoch != event_epoch
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

fn verify_delivery(
    connection: &Connection,
    delivery: &PluginInvocationDelivery,
    invocation: &PluginInvocation,
    persisted_entry_id: &PluginId,
) -> Result<(), RepositoryError> {
    delivery.verify(PluginInvocationDeliveryCheck {
        operation_id: invocation.operation_id,
        plugin_id: &invocation.plugin_id,
        package_generation: invocation.package_generation,
        activation_epoch: invocation.activation_epoch,
        hook: invocation.hook_kind,
        persisted_entry_id,
        stored_request_sha256: &invocation.request_sha256,
    })?;
    verify_retained_event_source(connection, delivery)
}

fn invocation_request_material(request: &ReservePluginInvocationRequest, now: Timestamp) -> usize {
    request.operation_id.to_string().len()
        + request.plugin_id.as_str().len()
        + 16
        + hook_kind_name(request.hook_kind).len()
        + 64
        + request.request_sha256.as_str().len()
        + request.delivery_operation_id.to_string().len()
        + invocation_state_name(PluginInvocationState::Reserved).len()
        + now.to_string().len() * 2
        + now
            .checked_add((PLUGIN_INVOCATION_RETENTION_DAYS * 24).hours())
            .map_or(0, |value| value.to_string().len())
}

#[cfg(test)]
fn reserve_invocation_for_test(
    connection: &mut Connection,
    request: ReservePluginInvocationRequest,
    now: Timestamp,
) -> Result<ReservedPluginInvocation, RepositoryError> {
    reserve_plugin_invocation_with_delivery(connection, request, None, now)
}

pub(crate) fn reserve_authorized_plugin_invocation(
    connection: &mut Connection,
    request: AuthorizedReservePluginInvocationRequest,
    now: Timestamp,
) -> Result<ReservedPluginInvocation, RepositoryError> {
    let AuthorizedReservePluginInvocationRequest { request, delivery } = request;
    reserve_plugin_invocation_with_delivery(connection, request, Some(&delivery), now)
}

fn reserve_plugin_invocation_with_delivery(
    connection: &mut Connection,
    request: ReservePluginInvocationRequest,
    delivery: Option<&PluginInvocationDelivery>,
    now: Timestamp,
) -> Result<ReservedPluginInvocation, RepositoryError> {
    if let Some(delivery) = delivery {
        delivery.verify(PluginInvocationDeliveryCheck {
            operation_id: request.operation_id,
            plugin_id: &request.plugin_id,
            package_generation: request.package_generation,
            activation_epoch: request.activation_epoch,
            hook: request.hook_kind,
            persisted_entry_id: &delivery.persisted_entry_id,
            stored_request_sha256: &request.request_sha256,
        })?;
    }
    cleanup_expired_receipts(connection, now)?;
    let resource_health_operation_id = resource_health_operation_id(request.operation_id);
    let resource_health_request = resource_health_request_json(&request)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    // Receipt authority is checked under the same immediate reservation lock.
    // A concurrent terminalization cannot commit between this read and insert.
    if read_receipt_response(
        &transaction,
        resource_health_operation_id,
        &resource_health_request,
    )?
    .is_some()
    {
        return Err(RepositoryError::OperationTooLarge);
    }
    if operator_origin(request.hook_kind) {
        let receipt_request = reservation_receipt_request_json(&request, delivery)?;
        if let Some(response) =
            read_receipt_response(&transaction, request.operation_id, &receipt_request)?
        {
            let mut committed: CommittedPluginInvocation =
                serde_json::from_str(&response).map_err(storage_error)?;
            committed.replayed = true;
            transaction.commit().map_err(storage_error)?;
            return Ok(ReservedPluginInvocation::TerminalReplay(Box::new(
                committed,
            )));
        }
    }
    let plugin = load_installed_plugin(&transaction, &request.plugin_id)?;
    let entry_authority = plugin_manifest_entry_authority(
        &plugin.manifest,
        request.hook_kind,
        PluginManifestEntrySelector::Requested(&request.entry),
    )
    .ok_or(RepositoryError::Conflict)?;
    if let Some(delivery) = delivery {
        delivery.verify(PluginInvocationDeliveryCheck {
            operation_id: request.operation_id,
            plugin_id: &request.plugin_id,
            package_generation: request.package_generation,
            activation_epoch: request.activation_epoch,
            hook: request.hook_kind,
            persisted_entry_id: &entry_authority.persisted_id,
            stored_request_sha256: &request.request_sha256,
        })?;
        verify_retained_event_source(&transaction, delivery)?;
    }
    let runtime_admits_hook = delivery_runtime_admits(&plugin, request.hook_kind, delivery, now);
    let cursor = load_plugin_cursor(&transaction, &request.plugin_id)?;
    let cursor_admits_hook = match request.hook_kind {
        PluginHookKind::Resync => cursor.resync_required,
        PluginHookKind::InvokeCommand
        | PluginHookKind::HandleEvent
        | PluginHookKind::HandleSurfaceAction => !cursor.resync_required,
    };
    if plugin.package_generation != request.package_generation
        || plugin.activation_epoch != request.activation_epoch
        || now < plugin.updated_at
        || !plugin.desired_enabled
        || !runtime_admits_hook
        || !cursor_admits_hook
    {
        return Err(RepositoryError::Conflict);
    }
    match (request.hook_kind, request.resync_session.as_ref()) {
        (PluginHookKind::Resync, Some(session))
            if session.operation_id == request.operation_id
                && session.plugin_id == request.plugin_id
                && session.package_generation == request.package_generation
                && session.activation_epoch == request.activation_epoch
                && if let Some(delivery) = delivery {
                    plugin_resync_request_hash(session) == delivery.authority.payload_sha256
                } else {
                    plugin_resync_request_hash(session) == request.request_sha256
                } =>
        {
            validate_resync_session(&transaction, session, now)?;
        }
        (PluginHookKind::Resync, _) | (_, Some(_)) => return Err(RepositoryError::Conflict),
        (_, None) => {}
    }
    if !hook_capability_granted(
        &transaction,
        &plugin,
        &entry_authority.entry,
        entry_authority.required_capability,
    )? {
        return Err(RepositoryError::Conflict);
    }
    match load_invocation(&transaction, request.operation_id) {
        Ok(existing) => {
            if !invocation_identity_matches(&existing, &request) {
                return Err(RepositoryError::IdempotencyMismatch);
            }
            if existing.retain_until <= now {
                return Err(RepositoryError::Conflict);
            }
            transaction.commit().map_err(storage_error)?;
            return Ok(ReservedPluginInvocation::InFlightReplay(existing));
        }
        Err(RepositoryError::NotFound) => {}
        Err(error) => return Err(error),
    }

    transaction
        .execute(
            "DELETE FROM plugin_invocations
             WHERE retain_until <= ?1 AND state IN ('reserved', 'effect_committing')",
            [now.to_string()],
        )
        .map_err(storage_error)?;
    if has_other_active_invocation(&transaction, &request.plugin_id, None)? {
        return Err(RepositoryError::Conflict);
    }

    let retained_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM plugin_invocations", [], |row| {
            row.get(0)
        })
        .map_err(storage_error)?;
    let retained_material: i64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(
                LENGTH(CAST(operation_id AS BLOB)) + LENGTH(CAST(plugin_id AS BLOB)) + 16 +
                LENGTH(CAST(hook_kind AS BLOB)) + LENGTH(CAST(entry_id AS BLOB)) +
                LENGTH(CAST(request_hash AS BLOB)) + LENGTH(CAST(delivery_id AS BLOB)) +
                LENGTH(CAST(state AS BLOB)) + COALESCE(LENGTH(CAST(error_code AS BLOB)), 0) +
                LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB)) +
                LENGTH(CAST(retain_until AS BLOB))
             ), 0) FROM plugin_invocations",
            [],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let (plugin_count, plugin_material): (i64, i64) = transaction
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(
                LENGTH(CAST(operation_id AS BLOB)) + LENGTH(CAST(plugin_id AS BLOB)) + 16 +
                LENGTH(CAST(hook_kind AS BLOB)) + LENGTH(CAST(entry_id AS BLOB)) +
                LENGTH(CAST(request_hash AS BLOB)) + LENGTH(CAST(delivery_id AS BLOB)) +
                LENGTH(CAST(state AS BLOB)) + COALESCE(LENGTH(CAST(error_code AS BLOB)), 0) +
                LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB)) +
                LENGTH(CAST(retain_until AS BLOB))
             ), 0) FROM plugin_invocations
             WHERE plugin_id = ?1",
            [request.plugin_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    let request_material = invocation_request_material(&request, now);
    let projected = usize::try_from(retained_material)
        .map_err(storage_error)?
        .saturating_add(request_material);
    let projected_plugin = usize::try_from(plugin_material)
        .map_err(storage_error)?
        .saturating_add(request_material);
    if retained_count >= PLUGIN_INVOCATIONS_MAX as i64
        || plugin_count >= PLUGIN_INVOCATIONS_PER_PLUGIN_MAX as i64
        || projected > PLUGIN_INVOCATION_MATERIAL_BYTES_MAX
        || projected_plugin > PLUGIN_INVOCATION_MATERIAL_PER_PLUGIN_BYTES_MAX
    {
        let plugins = load_plugins(&transaction)?;
        let enabled_dependents: Vec<_> = dependent_closure(&plugins, &request.plugin_id)
            .into_iter()
            .filter_map(|dependent| {
                plugins
                    .iter()
                    .find(|candidate| candidate.plugin_id == dependent && candidate.desired_enabled)
                    .cloned()
            })
            .collect();
        next_activation_epoch(plugin.activation_epoch)?;
        for dependent in &enabled_dependents {
            next_activation_epoch(dependent.activation_epoch)?;
        }
        let affected: Vec<_> = std::iter::once(plugin.plugin_id.clone())
            .chain(
                enabled_dependents
                    .iter()
                    .map(|dependent| dependent.plugin_id.clone()),
            )
            .collect();
        let plugin_id = plugin.plugin_id.clone();
        let committed = mutate_in_transaction(
            &transaction,
            resource_health_operation_id,
            resource_health_request,
            now,
            |tx, _| {
                force_suspend_plugin(tx, &plugin, "resource_limit", now)?;
                for dependent in &enabled_dependents {
                    force_suspend_plugin(tx, dependent, "dependency_failed", now)?;
                }
                let stored = load_installed_plugin(tx, &plugin_id)?;
                Ok(plugin_effect(
                    EventType::PLUGIN_HEALTH_CHANGED,
                    Some(&stored),
                    affected,
                    Some(stored.plugin_id.to_string()),
                ))
            },
        )?;
        transaction.commit().map_err(storage_error)?;
        if committed.newly_committed {
            let _ = prune_retained_events(connection);
        }
        return Err(RepositoryError::OperationTooLarge);
    }
    let retain_until = now
        .checked_add((PLUGIN_INVOCATION_RETENTION_DAYS * 24).hours())
        .map_err(storage_error)?;
    transaction
        .execute(
            "INSERT INTO plugin_invocations(
                operation_id, plugin_id, package_generation, activation_epoch,
                hook_kind, entry_id, request_hash, delivery_id,
                state, created_at, updated_at, retain_until
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reserved', ?9, ?9, ?10)",
            params![
                request.operation_id.to_string(),
                request.plugin_id.as_str(),
                as_i64(request.package_generation, "invocation generation")?,
                as_i64(request.activation_epoch, "invocation epoch")?,
                hook_kind_name(request.hook_kind),
                entry_authority.persisted_id.as_str(),
                request.request_sha256.as_str(),
                request.delivery_operation_id.to_string(),
                now.to_string(),
                retain_until.to_string(),
            ],
        )
        .map_err(storage_error)?;
    let invocation = load_invocation(&transaction, request.operation_id)?;
    if invocation_material_bytes(&transaction)? > PLUGIN_INVOCATION_MATERIAL_BYTES_MAX as i64 {
        return Err(RepositoryError::OperationTooLarge);
    }
    transaction.commit().map_err(storage_error)?;
    Ok(ReservedPluginInvocation::Reserved(invocation))
}

fn legal_invocation_transition(from: PluginInvocationState, to: PluginInvocationState) -> bool {
    matches!(
        (from, to),
        (
            PluginInvocationState::Reserved,
            PluginInvocationState::DispatchingHttp | PluginInvocationState::EffectCommitting
        ) | (
            PluginInvocationState::DispatchingHttp,
            PluginInvocationState::AmbiguousHttp
        ) | (
            PluginInvocationState::AmbiguousHttp,
            PluginInvocationState::DispatchingHttp
        )
    )
}

#[cfg(test)]
fn transition_invocation_for_test(
    connection: &mut Connection,
    request: TransitionPluginInvocationRequest,
    now: Timestamp,
) -> Result<PluginInvocation, RepositoryError> {
    transition_plugin_invocation_with_delivery(connection, request, None, now)
}

pub(crate) fn transition_authorized_plugin_invocation(
    connection: &mut Connection,
    request: AuthorizedTransitionPluginInvocationRequest,
    now: Timestamp,
) -> Result<PluginInvocation, RepositoryError> {
    let AuthorizedTransitionPluginInvocationRequest { request, delivery } = request;
    transition_plugin_invocation_with_delivery(connection, request, Some(&delivery), now)
}

fn transition_plugin_invocation_with_delivery(
    connection: &mut Connection,
    request: TransitionPluginInvocationRequest,
    delivery: Option<&PluginInvocationDelivery>,
    now: Timestamp,
) -> Result<PluginInvocation, RepositoryError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let plugin = load_installed_plugin(&transaction, &request.plugin_id)?;
    let invocation = load_invocation(&transaction, request.operation_id)?;
    if plugin.package_generation != request.package_generation
        || plugin.activation_epoch != request.activation_epoch
        || invocation.plugin_id != request.plugin_id
        || invocation.package_generation != request.package_generation
        || invocation.activation_epoch != request.activation_epoch
        || now < invocation.updated_at
        || invocation.retain_until <= now
    {
        return Err(RepositoryError::Conflict);
    }
    let entry_authority = plugin_manifest_entry_authority(
        &plugin.manifest,
        invocation.hook_kind,
        PluginManifestEntrySelector::Requested(&invocation.entry),
    )
    .ok_or(RepositoryError::Conflict)?;
    if let Some(delivery) = delivery {
        verify_delivery(
            &transaction,
            delivery,
            &invocation,
            &entry_authority.persisted_id,
        )?;
    }
    let required_capability_granted = hook_capability_granted(
        &transaction,
        &plugin,
        &entry_authority.entry,
        entry_authority.required_capability,
    )?;
    if !legal_invocation_transition(request.expected_state, request.next_state)
        || (request.next_state == PluginInvocationState::DispatchingHttp
            && (invocation.hook_kind == PluginHookKind::Resync
                || delivery
                    .is_some_and(|delivery| delivery.authority.mode != PluginDeliveryMode::Active)
                || !has_capability(&transaction, &plugin, Capability::Http)?
                || !required_capability_granted))
    {
        return Err(RepositoryError::Conflict);
    }
    let records_http_ambiguity = request.expected_state == PluginInvocationState::DispatchingHttp
        && request.next_state == PluginInvocationState::AmbiguousHttp;
    let runtime_admits_transition = records_http_ambiguity
        || (plugin.desired_enabled
            && delivery_runtime_admits(&plugin, invocation.hook_kind, delivery, now));
    if !runtime_admits_transition {
        return Err(RepositoryError::Conflict);
    }
    if invocation.state == request.next_state {
        transaction.commit().map_err(storage_error)?;
        return Ok(invocation);
    }
    if invocation.state != request.expected_state
        || (request.expected_state == PluginInvocationState::AmbiguousHttp
            && request.next_state == PluginInvocationState::DispatchingHttp
            && has_other_active_invocation(
                &transaction,
                &request.plugin_id,
                Some(request.operation_id),
            )?)
    {
        return Err(RepositoryError::Conflict);
    }
    let changed = transaction
        .execute(
            "UPDATE plugin_invocations SET state = ?2, error_code = ?3, updated_at = ?4
             WHERE operation_id = ?1 AND state = ?5",
            params![
                request.operation_id.to_string(),
                invocation_state_name(request.next_state),
                if request.next_state == PluginInvocationState::AmbiguousHttp {
                    Some("http_ambiguous")
                } else {
                    None
                },
                now.to_string(),
                invocation_state_name(request.expected_state),
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    let updated = load_invocation(&transaction, request.operation_id)?;
    transaction.commit().map_err(storage_error)?;
    Ok(updated)
}

pub(crate) fn list_plugin_invocations(
    connection: &Connection,
) -> Result<Vec<PluginInvocation>, RepositoryError> {
    let mut statement = connection
        .prepare("SELECT operation_id FROM plugin_invocations ORDER BY created_at, operation_id")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    let mut out = Vec::new();
    for row in rows {
        if out.len() == PLUGIN_INVOCATIONS_MAX {
            return Err(RepositoryError::Storage(
                "plugin invocation bound exceeded".to_owned(),
            ));
        }
        let operation_id =
            OperationId::parse(&row.map_err(storage_error)?).map_err(storage_error)?;
        out.push(load_invocation(connection, operation_id)?);
    }
    if invocation_material_bytes(connection)? > PLUGIN_INVOCATION_MATERIAL_BYTES_MAX as i64 {
        return Err(RepositoryError::Storage(
            "plugin invocation material exceeded".to_owned(),
        ));
    }
    Ok(out)
}

fn verify_invocation_fence(
    connection: &Connection,
    operation_id: OperationId,
    plugin_id: &PluginId,
    package_generation: u64,
    activation_epoch: u64,
) -> Result<(InstalledPlugin, PluginInvocation), RepositoryError> {
    let plugin = load_installed_plugin(connection, plugin_id)?;
    let invocation = load_invocation(connection, operation_id)?;
    if plugin.package_generation != package_generation
        || plugin.activation_epoch != activation_epoch
        || invocation.plugin_id != *plugin_id
        || invocation.package_generation != package_generation
        || invocation.activation_epoch != activation_epoch
    {
        return Err(RepositoryError::Conflict);
    }
    Ok((plugin, invocation))
}

struct PluginInvocationCompletionFence {
    operation_id: OperationId,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
}

#[cfg(test)]
fn terminalize_invocation_for_test(
    connection: &mut Connection,
    operation_id: OperationId,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    now: Timestamp,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    terminalize_plugin_invocation_with(
        connection,
        operation_id,
        plugin_id,
        package_generation,
        activation_epoch,
        now,
        || Ok(()),
    )
}

pub(crate) fn complete_authorized_plugin_invocation(
    connection: &mut Connection,
    request: CompletePluginInvocationRequest,
    now: Timestamp,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    terminalize_plugin_invocation_with_delivery(
        connection,
        PluginInvocationCompletionFence {
            operation_id: request.operation_id,
            plugin_id: request.plugin_id,
            package_generation: request.package_generation,
            activation_epoch: request.activation_epoch,
        },
        Some(&request.delivery),
        now,
        || Ok(()),
    )
}

#[cfg(test)]
fn terminalize_plugin_invocation_with(
    connection: &mut Connection,
    operation_id: OperationId,
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    now: Timestamp,
    before_commit: impl FnOnce() -> Result<(), RepositoryError>,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    terminalize_plugin_invocation_with_delivery(
        connection,
        PluginInvocationCompletionFence {
            operation_id,
            plugin_id,
            package_generation,
            activation_epoch,
        },
        None,
        now,
        before_commit,
    )
}

fn terminalize_plugin_invocation_with_delivery(
    connection: &mut Connection,
    fence: PluginInvocationCompletionFence,
    delivery: Option<&PluginInvocationDelivery>,
    now: Timestamp,
    before_commit: impl FnOnce() -> Result<(), RepositoryError>,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    cleanup_expired_receipts(connection, now)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let (plugin, invocation) = verify_invocation_fence(
        &transaction,
        fence.operation_id,
        &fence.plugin_id,
        fence.package_generation,
        fence.activation_epoch,
    )?;
    let entry_authority = plugin_manifest_entry_authority(
        &plugin.manifest,
        invocation.hook_kind,
        PluginManifestEntrySelector::Requested(&invocation.entry),
    )
    .ok_or(RepositoryError::Conflict)?;
    if let Some(delivery) = delivery {
        verify_delivery(
            &transaction,
            delivery,
            &invocation,
            &entry_authority.persisted_id,
        )?;
        if delivery.authority.mode != PluginDeliveryMode::Active {
            return Err(RepositoryError::Conflict);
        }
    }
    let runtime_admits_terminal =
        delivery_runtime_admits(&plugin, invocation.hook_kind, delivery, now);
    if !plugin.desired_enabled
        || now < plugin.updated_at
        || !runtime_admits_terminal
        || !operator_origin(invocation.hook_kind)
        || !matches!(
            invocation.state,
            PluginInvocationState::Reserved | PluginInvocationState::DispatchingHttp
        )
    {
        return Err(RepositoryError::Conflict);
    }
    let terminal_kind = if invocation.state == PluginInvocationState::DispatchingHttp {
        PluginInvocationTerminalKind::Http
    } else {
        PluginInvocationTerminalKind::ReadOnly
    };
    let deleted = transaction
        .execute(
            "DELETE FROM plugin_invocations WHERE operation_id = ?1 AND state = ?2",
            params![
                fence.operation_id.to_string(),
                invocation_state_name(invocation.state)
            ],
        )
        .map_err(storage_error)?;
    if deleted != 1 {
        return Err(RepositoryError::Conflict);
    }
    let committed = CommittedPluginInvocation {
        terminal_kind,
        mutation: None,
        cursor: None,
        rejection: None,
        replayed: false,
    };
    let receipt_request = stored_invocation_receipt_request_json(&invocation, delivery)?;
    let response = serde_json::to_string(&committed).map_err(storage_error)?;
    write_receipt_response_in_transaction(
        &transaction,
        invocation.operation_id,
        &receipt_request,
        &response,
        now,
    )?;
    before_commit()?;
    transaction.commit().map_err(storage_error)?;
    Ok(committed)
}

struct StorageMutationUnitOfWork<'a> {
    connection: &'a mut Connection,
    now: Timestamp,
}

impl ApplicationMutationUnitOfWork for StorageMutationUnitOfWork<'_> {
    fn create_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        draft: junban_domain::TaskDraft,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::create_task(self.connection, operation_id, task_id, draft, self.now)
    }

    fn patch_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        patch: junban_app::TaskPatch,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::patch_task(self.connection, operation_id, task_id, patch, self.now)
    }

    fn complete_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        temporal: junban_app::TemporalContext,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::complete_task(self.connection, operation_id, task_id, self.now, temporal)
    }

    fn uncomplete_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
        temporal: junban_app::TemporalContext,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::uncomplete_task(self.connection, operation_id, task_id, self.now, temporal)
    }

    fn cancel_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::cancel_task(self.connection, operation_id, task_id, self.now)
    }

    fn reopen_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::reopen_task(self.connection, operation_id, task_id, self.now)
    }

    fn delete_task(
        &mut self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::delete_task(self.connection, operation_id, task_id, self.now)
    }

    fn bulk_tasks(
        &mut self,
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: junban_app::BulkAction,
        temporal: junban_app::TemporalContext,
    ) -> Result<CommittedMutation, RepositoryError> {
        task_ops::bulk_tasks(
            self.connection,
            operation_id,
            task_ids,
            action,
            self.now,
            temporal,
        )
    }

    fn create_project(
        &mut self,
        operation_id: OperationId,
        project_id: ProjectId,
        draft: junban_app::ProjectDraft,
    ) -> Result<CommittedMutation, RepositoryError> {
        catalog_ops::create_project(self.connection, operation_id, project_id, draft, self.now)
    }

    fn patch_project(
        &mut self,
        operation_id: OperationId,
        project_id: ProjectId,
        patch: junban_app::ProjectPatch,
    ) -> Result<CommittedMutation, RepositoryError> {
        catalog_ops::patch_project(self.connection, operation_id, project_id, patch, self.now)
    }

    fn delete_project(
        &mut self,
        operation_id: OperationId,
        project_id: ProjectId,
    ) -> Result<CommittedMutation, RepositoryError> {
        catalog_ops::delete_project(self.connection, operation_id, project_id, self.now)
    }

    fn create_tag(
        &mut self,
        operation_id: OperationId,
        tag_id: TagId,
        draft: junban_app::TagDraft,
    ) -> Result<CommittedMutation, RepositoryError> {
        catalog_ops::create_tag(self.connection, operation_id, tag_id, draft, self.now)
    }

    fn patch_tag(
        &mut self,
        operation_id: OperationId,
        tag_id: TagId,
        patch: junban_app::TagPatch,
    ) -> Result<CommittedMutation, RepositoryError> {
        catalog_ops::patch_tag(self.connection, operation_id, tag_id, patch, self.now)
    }

    fn delete_tag(
        &mut self,
        operation_id: OperationId,
        tag_id: TagId,
    ) -> Result<CommittedMutation, RepositoryError> {
        catalog_ops::delete_tag(self.connection, operation_id, tag_id, self.now)
    }
}

#[cfg(test)]
fn commit_invocation_for_test(
    connection: &mut Connection,
    request: PlannedPluginInvocationCommit,
    now: Timestamp,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    commit_plugin_invocation_with(connection, request, now, || Ok(()))
}

pub(crate) fn commit_authorized_plugin_invocation(
    connection: &mut Connection,
    request: AuthorizedPlannedPluginInvocationCommit,
    now: Timestamp,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    commit_plugin_invocation_with_delivery(
        connection,
        request.planned,
        Some(&request.delivery),
        now,
        || Ok(()),
    )
}

#[cfg(test)]
fn commit_plugin_invocation_with(
    connection: &mut Connection,
    request: PlannedPluginInvocationCommit,
    now: Timestamp,
    after_domain_effect: impl FnOnce() -> Result<(), RepositoryError>,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    commit_plugin_invocation_with_delivery(connection, request, None, now, after_domain_effect)
}

fn commit_plugin_invocation_with_delivery(
    connection: &mut Connection,
    request: PlannedPluginInvocationCommit,
    delivery: Option<&PluginInvocationDelivery>,
    now: Timestamp,
    after_domain_effect: impl FnOnce() -> Result<(), RepositoryError>,
) -> Result<CommittedPluginInvocation, RepositoryError> {
    if request.domain_mutation.is_some() && request.kv_patch.is_some() {
        return Err(RepositoryError::Conflict);
    }
    if request.cursor.as_ref().is_some_and(|cursor| {
        cursor.plugin_id != request.plugin_id
            || cursor.package_generation != request.package_generation
            || cursor.activation_epoch != request.activation_epoch
    }) {
        return Err(RepositoryError::Conflict);
    }
    cleanup_expired_receipts(connection, now)?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(storage_error)?;
    let result = (|| {
        let (plugin, invocation) = verify_invocation_fence(
            connection,
            request.invocation_operation_id,
            &request.plugin_id,
            request.package_generation,
            request.activation_epoch,
        )?;
        if invocation.retain_until <= now {
            return Err(RepositoryError::Conflict);
        }
        let runtime_admits_terminal =
            delivery_runtime_admits(&plugin, invocation.hook_kind, delivery, now);
        if !plugin.desired_enabled || now < plugin.updated_at || !runtime_admits_terminal {
            return Err(RepositoryError::Conflict);
        }
        let entry_authority = plugin_manifest_entry_authority(
            &plugin.manifest,
            invocation.hook_kind,
            PluginManifestEntrySelector::Requested(&invocation.entry),
        )
        .ok_or(RepositoryError::Conflict)?;
        if let Some(delivery) = delivery {
            verify_delivery(
                connection,
                delivery,
                &invocation,
                &entry_authority.persisted_id,
            )?;
            if let Some(source) = delivery.retained_event_source() {
                let cursor = request.cursor.as_ref().ok_or(RepositoryError::Conflict)?;
                if cursor.expected != source.expected_cursor || cursor.next != source.next_cursor {
                    return Err(RepositoryError::Conflict);
                }
            }
        }
        if !hook_capability_granted(
            connection,
            &plugin,
            &entry_authority.entry,
            entry_authority.required_capability,
        )? {
            return Err(RepositoryError::Conflict);
        }
        let effect_committing = invocation.state == PluginInvocationState::EffectCommitting;
        let dispatching_http = invocation.state == PluginInvocationState::DispatchingHttp;
        let invalid_cursor_mode = match invocation.hook_kind {
            PluginHookKind::HandleEvent => request.cursor.as_ref().is_none_or(|cursor| {
                cursor.expected.resync_required || cursor.next.resync_required
            }),
            PluginHookKind::Resync => request.cursor.as_ref().is_none_or(|cursor| {
                !cursor.expected.resync_required || cursor.next.resync_required
            }),
            PluginHookKind::InvokeCommand | PluginHookKind::HandleSurfaceAction => {
                request.cursor.is_some()
            }
        };
        let resync = invocation.hook_kind == PluginHookKind::Resync;
        let resync_identity_valid = match (resync, request.resync_session.as_ref()) {
            (true, Some(session)) => {
                validate_resync_session(connection, session, now)?;
                session.operation_id == invocation.operation_id
                    && session.plugin_id == invocation.plugin_id
                    && session.package_generation == invocation.package_generation
                    && session.activation_epoch == invocation.activation_epoch
                    && if let Some(delivery) = delivery {
                        plugin_resync_request_hash(session) == delivery.authority.payload_sha256
                    } else {
                        plugin_resync_request_hash(session) == invocation.request_sha256
                    }
                    && request.cursor.as_ref().is_some_and(|cursor| {
                        cursor.expected == session.expected_cursor
                            && cursor.next.event_epoch == session.snapshot_event_epoch
                            && cursor.next.revision == session.snapshot_revision
                            && !cursor.next.resync_required
                    })
            }
            (false, None) => true,
            _ => false,
        };
        let starting_catch_up = delivery
            .is_some_and(|delivery| delivery.authority.mode == PluginDeliveryMode::StartingCatchUp);
        if (!effect_committing && !dispatching_http)
            || (dispatching_http
                && (request.domain_mutation.is_some() || request.kv_patch.is_some()))
            || (starting_catch_up
                && (dispatching_http
                    || request.domain_mutation.is_some()
                    || request.kv_patch.is_some()
                    || request.resync_kv.is_some()
                    || request.cursor.is_none()))
            || invalid_cursor_mode
            || !resync_identity_valid
            || (resync
                && (request.domain_mutation.is_some()
                    || request.kv_patch.is_some()
                    || request.resync_kv.is_none()))
            || (!resync && request.resync_kv.is_some())
        {
            return Err(RepositoryError::Conflict);
        }
        if let Some(mutation) = &request.domain_mutation
            && !has_capability(connection, &plugin, mutation.required_capability())?
        {
            return Err(RepositoryError::Conflict);
        }
        if (request.kv_patch.is_some()
            || matches!(
                request.resync_kv.as_ref(),
                Some(PluginResyncKvCommit::Replace(_))
            ))
            && !has_capability(connection, &plugin, Capability::Storage)?
        {
            return Err(RepositoryError::Conflict);
        }
        if let Some(PluginResyncKvCommit::Replace(entries)) = &request.resync_kv {
            validate_kv_replacement(entries)?;
        }
        if let Some(patch) = &request.kv_patch {
            validate_kv_patch(patch)?;
            // Compute all KV bounds before the child mutation performs its first write.
            let current = list_plugin_kv(connection, plugin.plugin_id.clone())?;
            let mut projected: BTreeMap<String, Vec<u8>> = current
                .into_iter()
                .map(|entry| (entry.key, entry.value))
                .collect();
            for key in &patch.delete {
                projected.remove(key);
            }
            for (key, value) in &patch.set {
                projected.insert(key.clone(), value.clone());
            }
            let bytes = projected
                .values()
                .fold(0_usize, |total, value| total.saturating_add(value.len()));
            if projected.len() > PLUGIN_KV_KEYS_MAX || bytes > PLUGIN_KV_BYTES_MAX {
                return Err(RepositoryError::OperationTooLarge);
            }
        }

        let terminal_kind = if dispatching_http {
            PluginInvocationTerminalKind::Http
        } else if request.domain_mutation.is_some() {
            PluginInvocationTerminalKind::DomainEffect
        } else if request.kv_patch.is_some() || request.resync_kv.is_some() {
            PluginInvocationTerminalKind::Kv
        } else {
            PluginInvocationTerminalKind::ReadOnly
        };
        let mut rejection = None;
        let mutation = match request.domain_mutation {
            Some(mutation) => {
                connection
                    .execute_batch("SAVEPOINT plugin_guest_effect")
                    .map_err(storage_error)?;
                let result = {
                    let mut unit_of_work = StorageMutationUnitOfWork { connection, now };
                    mutation.execute(&mut unit_of_work)
                };
                match result {
                    Ok(mutation) => {
                        connection
                            .execute_batch("RELEASE SAVEPOINT plugin_guest_effect")
                            .map_err(storage_error)?;
                        Some(mutation)
                    }
                    Err(error) => {
                        let Some(classification) =
                            PluginGuestEffectRejection::from_repository_error(&error)
                        else {
                            return Err(error);
                        };
                        connection
                            .execute_batch(
                                "ROLLBACK TO SAVEPOINT plugin_guest_effect;\
                                 RELEASE SAVEPOINT plugin_guest_effect",
                            )
                            .map_err(storage_error)?;
                        rejection = Some(classification);
                        None
                    }
                }
            }
            None => None,
        };
        after_domain_effect()?;
        if rejection.is_none() {
            if let Some(patch) = &request.kv_patch {
                apply_kv_patch(connection, &plugin, patch, now)?;
            }
            if let Some(PluginResyncKvCommit::Replace(entries)) = &request.resync_kv {
                apply_kv_replacement(connection, &plugin, entries, now)?;
            }
        }
        let cursor = if rejection.is_none() {
            request
                .cursor
                .as_ref()
                .map(|cursor| {
                    advance_cursor_in_transaction(
                        connection,
                        cursor,
                        now,
                        invocation.hook_kind == PluginHookKind::Resync,
                        false,
                    )
                })
                .transpose()?
        } else {
            None
        };
        let deleted = connection
            .execute(
                "DELETE FROM plugin_invocations
                 WHERE operation_id = ?1 AND state = ?2",
                params![
                    request.invocation_operation_id.to_string(),
                    invocation_state_name(invocation.state),
                ],
            )
            .map_err(storage_error)?;
        if deleted != 1 {
            return Err(RepositoryError::Conflict);
        }
        let committed = CommittedPluginInvocation {
            terminal_kind,
            mutation,
            cursor,
            rejection,
            replayed: false,
        };
        if operator_origin(invocation.hook_kind) {
            let receipt_request = stored_invocation_receipt_request_json(&invocation, delivery)?;
            let response = serde_json::to_string(&committed).map_err(storage_error)?;
            write_receipt_response_in_transaction(
                connection,
                invocation.operation_id,
                &receipt_request,
                &response,
                now,
            )?;
        }
        Ok(committed)
    })();
    match result {
        Ok(committed) => {
            if let Err(error) = connection.execute_batch("COMMIT") {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(storage_error(error));
            }
            if committed
                .mutation
                .as_ref()
                .is_some_and(|mutation| mutation.newly_committed)
            {
                let _ = prune_retained_events(connection);
            }
            Ok(committed)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn activation_attempt_authority_is_valid(plugin: &InstalledPlugin) -> bool {
    match plugin.runtime_state {
        PluginRuntimeState::Starting => {
            plugin.next_retry_at.is_none()
                && ((plugin.failure_count == 0 && plugin.last_error_code.is_none())
                    || (matches!(plugin.failure_count, 1 | 2) && plugin.last_error_code.is_some()))
        }
        PluginRuntimeState::Active => {
            plugin.failure_count == 0
                && plugin.last_error_code.is_none()
                && plugin.next_retry_at.is_none()
        }
        _ => false,
    }
}

fn scheduled_retry_authority_is_valid(plugin: &InstalledPlugin) -> bool {
    ((plugin.runtime_state == PluginRuntimeState::Degraded && plugin.failure_count == 1)
        || (plugin.runtime_state == PluginRuntimeState::Failed && plugin.failure_count == 2))
        && plugin.last_error_code.is_some()
        && plugin.next_retry_at.is_some()
}

fn failure_progression(
    current_count: u32,
    now: Timestamp,
) -> Result<(u32, PluginRuntimeState, Option<Timestamp>), RepositoryError> {
    let next_count = current_count
        .checked_add(1)
        .filter(|count| *count <= 3)
        .ok_or(RepositoryError::Conflict)?;
    let target = match next_count {
        1 => PluginRuntimeState::Degraded,
        2 => PluginRuntimeState::Failed,
        3 => PluginRuntimeState::Suspended,
        _ => unreachable!("bounded failure progression"),
    };
    let retry_at = if next_count < 3 {
        let shift = next_count.saturating_sub(1);
        let seconds = PLUGIN_FAILURE_BACKOFF_START_SECONDS
            .saturating_mul(1_i64 << shift)
            .min(PLUGIN_FAILURE_BACKOFF_MAX_SECONDS);
        Some(now.checked_add(seconds.seconds()).map_err(storage_error)?)
    } else {
        None
    };
    Ok((next_count, target, retry_at))
}

fn abandon_plugin_attempt(
    connection: &Connection,
    plugin_id: &PluginId,
) -> Result<(), RepositoryError> {
    connection
        .execute(
            "UPDATE plugin_invocations
             SET state = 'ambiguous_http', error_code = 'http_ambiguous'
             WHERE plugin_id = ?1 AND state = 'dispatching_http'",
            [plugin_id.as_str()],
        )
        .map_err(storage_error)?;
    connection
        .execute(
            "DELETE FROM plugin_invocations
             WHERE plugin_id = ?1 AND state IN ('reserved', 'effect_committing')",
            [plugin_id.as_str()],
        )
        .map_err(storage_error)?;
    Ok(())
}

#[derive(Serialize)]
struct DuePluginRetryReceiptRequest<'a> {
    op: &'static str,
    request: &'a DuePluginRetryRequest,
}

pub(crate) fn retry_due_plugin(
    connection: &mut Connection,
    operation_id: OperationId,
    request: DuePluginRetryRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&DuePluginRetryReceiptRequest {
        op: "retry_due_plugin",
        request: &request,
    })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        tx.execute_batch("PRAGMA defer_foreign_keys = ON;")
            .map_err(storage_error)?;
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.plugin_id == request.plugin_id)
            .cloned()
            .ok_or(RepositoryError::NotFound)?;
        if !matches!(
            request.expected_runtime_state,
            PluginRuntimeState::Degraded | PluginRuntimeState::Failed
        ) || plugin.package_generation != request.package_generation
            || plugin.activation_epoch != request.activation_epoch
            || plugin.runtime_state != request.expected_runtime_state
            || plugin.next_retry_at != Some(request.expected_next_retry_at)
            || request.expected_next_retry_at > now
            || !plugin.desired_enabled
            || !scheduled_retry_authority_is_valid(&plugin)
            || now < plugin.updated_at
        {
            return Err(RepositoryError::Conflict);
        }
        let (invocations, ambiguous): (i64, i64) = tx
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(state = 'ambiguous_http'), 0)
                 FROM plugin_invocations WHERE plugin_id = ?1",
                [plugin.plugin_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(storage_error)?;
        if invocations != ambiguous {
            return Err(RepositoryError::Conflict);
        }
        let epoch = next_activation_epoch(plugin.activation_epoch)?;
        let changed = tx
            .execute(
                "UPDATE plugins SET activation_epoch = ?4, runtime_state = 'starting',
                    next_retry_at = NULL, updated_at = ?5
                 WHERE plugin_id = ?1 AND package_generation = ?2
                   AND activation_epoch = ?3 AND runtime_state = ?6
                   AND next_retry_at = ?7 AND desired_enabled = 1",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(plugin.package_generation, "package generation")?,
                    as_i64(plugin.activation_epoch, "activation epoch")?,
                    as_i64(epoch, "activation epoch")?,
                    now.to_string(),
                    runtime_state_name(request.expected_runtime_state),
                    request.expected_next_retry_at.to_string(),
                ],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(RepositoryError::Conflict);
        }
        tx.execute(
            "UPDATE plugin_invocations SET activation_epoch = ?2
             WHERE plugin_id = ?1 AND state = 'ambiguous_http'",
            params![
                plugin.plugin_id.as_str(),
                as_i64(epoch, "activation epoch")?
            ],
        )
        .map_err(storage_error)?;
        let stored = load_installed_plugin(tx, &plugin.plugin_id)?;
        Ok(plugin_effect(
            EventType::PLUGIN_RETRY_REQUESTED,
            Some(&stored),
            vec![stored.plugin_id.clone()],
            Some(stored.plugin_id.to_string()),
        ))
    })
}

#[derive(Serialize)]
struct CompletePluginActivationReceiptRequest<'a> {
    op: &'static str,
    request: &'a CompletePluginActivationRequest,
}

pub(crate) fn complete_plugin_activation(
    connection: &mut Connection,
    operation_id: OperationId,
    request: CompletePluginActivationRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&CompletePluginActivationReceiptRequest {
        op: "complete_plugin_activation",
        request: &request,
    })?;
    mutate(
        connection,
        operation_id,
        request_json,
        now,
        move |tx, revision| {
            let plugins = load_plugins(tx)?;
            validate_current_graph(tx, &plugins)?;
            let plugin = plugins
                .iter()
                .find(|plugin| plugin.plugin_id == request.plugin_id)
                .cloned()
                .ok_or(RepositoryError::NotFound)?;
            let cursor = load_plugin_cursor(tx, &plugin.plugin_id)?;
            let (event_epoch, head): (String, i64) = tx
                .query_row(
                    "SELECT event_epoch, global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(storage_error)?;
            let dependencies_active = plugin.manifest.dependencies.iter().all(|dependency| {
                plugins
                    .iter()
                    .find(|candidate| candidate.plugin_id.as_str() == dependency.id)
                    .is_some_and(|dependency| {
                        dependency.desired_enabled
                            && dependency.runtime_state == PluginRuntimeState::Active
                    })
            });
            let blocking_invocation: bool = tx
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM plugin_invocations
                        WHERE plugin_id = ?1
                          AND state IN ('reserved', 'effect_committing', 'dispatching_http')
                    )",
                    [plugin.plugin_id.as_str()],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            let invalid_ambiguity: bool = tx
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM plugin_invocations
                        WHERE plugin_id = ?1 AND state = 'ambiguous_http'
                          AND (error_code != 'http_ambiguous'
                               OR package_generation != ?2
                               OR activation_epoch != ?3
                               OR hook_kind = 'resync')
                    )",
                    params![
                        plugin.plugin_id.as_str(),
                        as_i64(plugin.package_generation, "package generation")?,
                        as_i64(plugin.activation_epoch, "activation epoch")?,
                    ],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if plugin.package_generation != request.package_generation
                || plugin.activation_epoch != request.activation_epoch
                || plugin.runtime_state != PluginRuntimeState::Starting
                || !plugin.desired_enabled
                || !activation_attempt_authority_is_valid(&plugin)
                || now < plugin.updated_at
                || now < cursor.updated_at
                || cursor.resync_required
                || cursor.event_epoch != event_epoch
                || as_i64(cursor.revision, "cursor revision")? != head
                || !dependencies_active
                || blocking_invocation
                || invalid_ambiguity
            {
                return Err(RepositoryError::Conflict);
            }
            let changed = tx
                .execute(
                    "UPDATE plugins SET runtime_state = 'active', failure_count = 0,
                        last_error_code = NULL, next_retry_at = NULL, updated_at = ?4
                     WHERE plugin_id = ?1 AND package_generation = ?2
                       AND activation_epoch = ?3 AND runtime_state = 'starting'
                       AND desired_enabled = 1",
                    params![
                        plugin.plugin_id.as_str(),
                        as_i64(plugin.package_generation, "package generation")?,
                        as_i64(plugin.activation_epoch, "activation epoch")?,
                        now.to_string(),
                    ],
                )
                .map_err(storage_error)?;
            if changed != 1 {
                return Err(RepositoryError::Conflict);
            }
            let cursor_changed = tx
                .execute(
                    "UPDATE plugin_event_cursors SET revision = ?2, updated_at = ?3
                     WHERE plugin_id = ?1 AND revision = ?4 AND resync_required = 0",
                    params![
                        plugin.plugin_id.as_str(),
                        revision_to_i64(revision)?,
                        now.to_string(),
                        head,
                    ],
                )
                .map_err(storage_error)?;
            if cursor_changed != 1 {
                return Err(RepositoryError::Conflict);
            }
            let stored = load_installed_plugin(tx, &plugin.plugin_id)?;
            Ok(plugin_effect(
                EventType::PLUGIN_HEALTH_CHANGED,
                Some(&stored),
                vec![stored.plugin_id.clone()],
                Some(stored.plugin_id.to_string()),
            ))
        },
    )
}

#[derive(Serialize)]
struct PluginAttemptFailureReceiptRequest<'a> {
    op: &'static str,
    request: &'a RecordPluginAttemptFailureRequest,
}

pub(crate) fn record_plugin_attempt_failure(
    connection: &mut Connection,
    operation_id: OperationId,
    request: RecordPluginAttemptFailureRequest,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request_json = canonical_json(&PluginAttemptFailureReceiptRequest {
        op: "record_plugin_attempt_failure",
        request: &request,
    })?;
    mutate(connection, operation_id, request_json, now, move |tx, _| {
        tx.execute_batch("PRAGMA defer_foreign_keys = ON;")
            .map_err(storage_error)?;
        let plugins = load_plugins(tx)?;
        validate_current_graph(tx, &plugins)?;
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.plugin_id == request.plugin_id)
            .cloned()
            .ok_or(RepositoryError::NotFound)?;
        if plugin.package_generation != request.package_generation
            || plugin.activation_epoch != request.activation_epoch
            || !plugin.desired_enabled
            || !matches!(
                plugin.runtime_state,
                PluginRuntimeState::Starting | PluginRuntimeState::Active
            )
            || !activation_attempt_authority_is_valid(&plugin)
            || now < plugin.updated_at
        {
            return Err(RepositoryError::Conflict);
        }
        let (failure_count, target_state, retry_at) =
            failure_progression(plugin.failure_count, now)?;
        let suspended = target_state == PluginRuntimeState::Suspended;
        let enabled_dependents: Vec<_> = if suspended {
            dependent_closure(&plugins, &plugin.plugin_id)
                .into_iter()
                .filter_map(|dependent| {
                    plugins
                        .iter()
                        .find(|candidate| {
                            candidate.plugin_id == dependent && candidate.desired_enabled
                        })
                        .cloned()
                })
                .collect()
        } else {
            Vec::new()
        };
        for dependent in &enabled_dependents {
            next_activation_epoch(dependent.activation_epoch)?;
        }
        abandon_plugin_attempt(tx, &plugin.plugin_id)?;
        let changed = tx
            .execute(
                "UPDATE plugins SET desired_enabled = ?4, runtime_state = ?5,
                    failure_count = ?6, last_error_code = ?7, next_retry_at = ?8,
                    updated_at = ?9
                 WHERE plugin_id = ?1 AND package_generation = ?2
                   AND activation_epoch = ?3 AND desired_enabled = 1
                   AND runtime_state = ?10 AND failure_count = ?11",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(plugin.package_generation, "package generation")?,
                    as_i64(plugin.activation_epoch, "activation epoch")?,
                    i64::from(!suspended),
                    runtime_state_name(target_state),
                    i64::from(failure_count),
                    request.cause.error_code(),
                    retry_at.map(|value| value.to_string()),
                    now.to_string(),
                    runtime_state_name(plugin.runtime_state),
                    i64::from(plugin.failure_count),
                ],
            )
            .map_err(storage_error)?;
        if changed != 1 {
            return Err(RepositoryError::Conflict);
        }
        if suspended {
            tx.execute(
                "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
                 WHERE plugin_id = ?1",
                params![plugin.plugin_id.as_str(), now.to_string()],
            )
            .map_err(storage_error)?;
            for dependent in &enabled_dependents {
                force_suspend_plugin(tx, dependent, "dependency_failed", now)?;
            }
        }
        let stored = load_installed_plugin(tx, &plugin.plugin_id)?;
        let mut affected = vec![stored.plugin_id.clone()];
        affected.extend(
            enabled_dependents
                .into_iter()
                .map(|dependent| dependent.plugin_id),
        );
        Ok(plugin_effect(
            EventType::PLUGIN_HEALTH_CHANGED,
            Some(&stored),
            affected,
            Some(stored.plugin_id.to_string()),
        ))
    })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PluginGraphFenceReceiptRequest {
    op: String,
    host_session_id: String,
    results: Vec<PluginGraphFenceResult>,
}

fn graph_fence_entry_role_is_valid(
    cause: PluginGraphFenceCause,
    disposition: PluginGraphFenceDisposition,
) -> bool {
    matches!(
        (cause, disposition),
        (
            PluginGraphFenceCause::CompileLoad | PluginGraphFenceCause::ChildFatal,
            PluginGraphFenceDisposition::Failing
        ) | (
            PluginGraphFenceCause::SessionLost,
            PluginGraphFenceDisposition::LoadedSibling
        ) | (
            PluginGraphFenceCause::DependencyFailed,
            PluginGraphFenceDisposition::SkippedDependent
        )
    )
}

fn graph_fence_role_set_is_valid(
    roles: impl IntoIterator<Item = (PluginGraphFenceCause, PluginGraphFenceDisposition)>,
) -> bool {
    let mut failing_count = 0;
    let mut has_skipped_dependent = false;
    for (cause, disposition) in roles {
        if !graph_fence_entry_role_is_valid(cause, disposition) {
            return false;
        }
        match disposition {
            PluginGraphFenceDisposition::Failing => failing_count += 1,
            PluginGraphFenceDisposition::SkippedDependent => has_skipped_dependent = true,
            PluginGraphFenceDisposition::LoadedSibling => {}
        }
    }
    failing_count == 1 || (failing_count == 0 && !has_skipped_dependent)
}

fn graph_fence_receipt_error() -> RepositoryError {
    RepositoryError::Storage("plugin graph fence receipt authority mismatch".to_owned())
}

fn graph_fence_result_shape_is_valid(result: &PluginGraphFenceResult) -> bool {
    let target_matches_count = matches!(
        (result.failure_count, result.target_runtime_state),
        (1, PluginRuntimeState::Degraded)
            | (2, PluginRuntimeState::Failed)
            | (3, PluginRuntimeState::Suspended)
    );
    result.package_generation > 0
        && result
            .expected_activation_epoch
            .checked_add(1)
            .is_some_and(|epoch| epoch == result.new_activation_epoch && epoch <= i64::MAX as u64)
        && matches!(
            result.prior_runtime_state,
            PluginRuntimeState::Starting | PluginRuntimeState::Active
        )
        && target_matches_count
        && result.desired_enabled == (result.target_runtime_state != PluginRuntimeState::Suspended)
        && graph_fence_entry_role_is_valid(result.cause, result.disposition)
}

pub(crate) fn validate_plugin_graph_fence_receipt(
    operation_id: OperationId,
    request_json: &str,
    response_json: &str,
) -> Result<PluginGraphFenceOutcome, RepositoryError> {
    let request: PluginGraphFenceReceiptRequest =
        serde_json::from_str(request_json).map_err(|_| graph_fence_receipt_error())?;
    let session =
        OperationId::parse(&request.host_session_id).map_err(|_| graph_fence_receipt_error())?;
    if canonical_json(&request)? != request_json
        || request.op != "fence_plugin_graph"
        || session.to_string() != request.host_session_id
        || request.results.is_empty()
        || request.results.len() > PLUGIN_GRAPH_FENCE_ENTRIES_MAX
        || !request
            .results
            .windows(2)
            .all(|pair| pair[0].plugin_id < pair[1].plugin_id)
        || !graph_fence_role_set_is_valid(
            request
                .results
                .iter()
                .map(|result| (result.cause, result.disposition)),
        )
        || request
            .results
            .iter()
            .any(|result| !graph_fence_result_shape_is_valid(result))
    {
        return Err(graph_fence_receipt_error());
    }

    let outcome: PluginGraphFenceOutcome =
        serde_json::from_str(response_json).map_err(|_| graph_fence_receipt_error())?;
    let affected = AffectedIds {
        plugin_ids: request
            .results
            .iter()
            .map(|result| result.plugin_id.clone())
            .collect(),
        ..AffectedIds::default()
    };
    let first = request
        .results
        .first()
        .ok_or_else(graph_fence_receipt_error)?;
    let snapshot_matches = matches!(
        outcome.mutation.event.snapshot.as_ref(),
        Some(ResourceSnapshot::Plugin { plugin })
            if plugin.plugin_id == first.plugin_id
                && plugin.package_generation == first.package_generation
                && plugin.activation_epoch == first.new_activation_epoch
                && plugin.desired_enabled == first.desired_enabled
                && plugin.runtime_state == first.target_runtime_state
                && plugin.last_error_code.as_deref() == Some(first.cause.error_code())
    );
    if canonical_json(&outcome)? != response_json
        || outcome.host_session_id != request.host_session_id
        || outcome.results != request.results
        || outcome.mutation.event.operation_id != operation_id
        || outcome.mutation.event.event_type.as_str() != EventType::PLUGIN_HEALTH_CHANGED
        || outcome.mutation.event.primary != Some(ResourceRef::plugin(&first.plugin_id))
        || !snapshot_matches
        || outcome.mutation.event.affected != affected
        || outcome.mutation.event.resync != ResyncScope::PLUGINS
        || outcome.mutation.uncomplete_outcome.is_some()
    {
        return Err(graph_fence_receipt_error());
    }
    Ok(outcome)
}

fn validate_graph_fence_request_shape(
    request: &PluginGraphFenceRequest,
) -> Result<(), RepositoryError> {
    let session =
        OperationId::parse(&request.host_session_id).map_err(|_| RepositoryError::Conflict)?;
    if request.entries.len() > PLUGIN_GRAPH_FENCE_ENTRIES_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    if session.to_string() != request.host_session_id
        || request.entries.is_empty()
        || !request
            .entries
            .windows(2)
            .all(|pair| pair[0].plugin_id < pair[1].plugin_id)
        || !graph_fence_role_set_is_valid(
            request
                .entries
                .iter()
                .map(|entry| (entry.cause, entry.disposition)),
        )
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

fn plugin_depends_on_any(
    plugins: &[InstalledPlugin],
    plugin: &InstalledPlugin,
    roots: &BTreeSet<PluginId>,
) -> bool {
    let by_id: BTreeMap<&str, &InstalledPlugin> = plugins
        .iter()
        .map(|candidate| (candidate.plugin_id.as_str(), candidate))
        .collect();
    let mut pending: VecDeque<_> = plugin
        .manifest
        .dependencies
        .iter()
        .map(|dependency| dependency.id.as_str())
        .collect();
    let mut visited = BTreeSet::new();
    while let Some(id) = pending.pop_front() {
        if !visited.insert(id) {
            continue;
        }
        if roots.iter().any(|root| root.as_str() == id) {
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

fn graph_fence_request_matches_results(
    request: &PluginGraphFenceRequest,
    stored: &PluginGraphFenceReceiptRequest,
) -> bool {
    stored.op == "fence_plugin_graph"
        && stored.host_session_id == request.host_session_id
        && stored.results.len() == request.entries.len()
        && request
            .entries
            .iter()
            .zip(&stored.results)
            .all(|(entry, result)| {
                entry.plugin_id == result.plugin_id
                    && entry.package_generation == result.package_generation
                    && entry.activation_epoch == result.expected_activation_epoch
                    && entry.cause == result.cause
                    && entry.disposition == result.disposition
                    && entry
                        .activation_epoch
                        .checked_add(1)
                        .is_some_and(|epoch| epoch == result.new_activation_epoch)
            })
}

fn read_graph_fence_replay(
    connection: &Connection,
    request: &PluginGraphFenceRequest,
) -> Result<Option<PluginGraphFenceOutcome>, RepositoryError> {
    let receipt = connection
        .query_row(
            "SELECT request_json, response_json FROM operation_receipts WHERE operation_id = ?1",
            [request.operation_id.to_string()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let Some((request_json, response_json)) = receipt else {
        return Ok(None);
    };
    let stored: PluginGraphFenceReceiptRequest =
        serde_json::from_str(&request_json).map_err(|_| RepositoryError::IdempotencyMismatch)?;
    if canonical_json(&stored)? != request_json
        || !graph_fence_request_matches_results(request, &stored)
    {
        return Err(RepositoryError::IdempotencyMismatch);
    }
    let mut outcome =
        validate_plugin_graph_fence_receipt(request.operation_id, &request_json, &response_json)?;
    outcome.mutation.newly_committed = false;
    Ok(Some(outcome))
}

pub(crate) fn fence_plugin_graph(
    connection: &mut Connection,
    request: PluginGraphFenceRequest,
    now: Timestamp,
) -> Result<PluginGraphFenceOutcome, RepositoryError> {
    validate_graph_fence_request_shape(&request)?;
    cleanup_expired_receipts(connection, now)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    if let Some(outcome) = read_graph_fence_replay(&transaction, &request)? {
        transaction.commit().map_err(storage_error)?;
        return Ok(outcome);
    }
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(storage_error)?;
    let plugins = load_plugins(&transaction)?;
    validate_current_graph(&transaction, &plugins)?;
    let failing: BTreeSet<_> = request
        .entries
        .iter()
        .filter(|entry| entry.disposition == PluginGraphFenceDisposition::Failing)
        .map(|entry| entry.plugin_id.clone())
        .collect();
    let mut results = Vec::with_capacity(request.entries.len());
    for entry in &request.entries {
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.plugin_id == entry.plugin_id)
            .ok_or(RepositoryError::NotFound)?;
        if plugin.package_generation != entry.package_generation
            || plugin.activation_epoch != entry.activation_epoch
            || !plugin.desired_enabled
            || !matches!(
                plugin.runtime_state,
                PluginRuntimeState::Starting | PluginRuntimeState::Active
            )
            || !activation_attempt_authority_is_valid(plugin)
            || now < plugin.updated_at
            || (entry.disposition == PluginGraphFenceDisposition::SkippedDependent
                && (plugin.runtime_state != PluginRuntimeState::Starting
                    || !plugin_depends_on_any(&plugins, plugin, &failing)))
        {
            return Err(RepositoryError::Conflict);
        }
        let new_epoch = next_activation_epoch(plugin.activation_epoch)?;
        let (failure_count, target_runtime_state, _) =
            failure_progression(plugin.failure_count, now)?;
        results.push(PluginGraphFenceResult {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            expected_activation_epoch: plugin.activation_epoch,
            new_activation_epoch: new_epoch,
            prior_runtime_state: plugin.runtime_state,
            target_runtime_state,
            failure_count,
            cause: entry.cause,
            desired_enabled: target_runtime_state != PluginRuntimeState::Suspended,
            disposition: entry.disposition,
        });
    }
    let receipt_request = PluginGraphFenceReceiptRequest {
        op: "fence_plugin_graph".to_owned(),
        host_session_id: request.host_session_id.clone(),
        results: results.clone(),
    };
    let request_json = canonical_json(&receipt_request)?;
    let affected: Vec<_> = results
        .iter()
        .map(|result| result.plugin_id.clone())
        .collect();
    let primary_id = affected.first().cloned();
    let applied_results = results.clone();
    let mutation = mutate_in_transaction(
        &transaction,
        request.operation_id,
        request_json.clone(),
        now,
        move |tx, _| {
            for result in &applied_results {
                abandon_plugin_attempt(tx, &result.plugin_id)?;
                let (_, _, retry_at) =
                    failure_progression(result.failure_count.saturating_sub(1), now)?;
                let changed = tx
                    .execute(
                        "UPDATE plugins SET activation_epoch = ?4, desired_enabled = ?5,
                            runtime_state = ?6, failure_count = ?7, last_error_code = ?8,
                            next_retry_at = ?9, updated_at = ?10
                         WHERE plugin_id = ?1 AND package_generation = ?2
                           AND activation_epoch = ?3 AND desired_enabled = 1
                           AND runtime_state = ?11",
                        params![
                            result.plugin_id.as_str(),
                            as_i64(result.package_generation, "package generation")?,
                            as_i64(result.expected_activation_epoch, "activation epoch")?,
                            as_i64(result.new_activation_epoch, "activation epoch")?,
                            i64::from(result.desired_enabled),
                            runtime_state_name(result.target_runtime_state),
                            i64::from(result.failure_count),
                            result.cause.error_code(),
                            retry_at.map(|value| value.to_string()),
                            now.to_string(),
                            runtime_state_name(result.prior_runtime_state),
                        ],
                    )
                    .map_err(storage_error)?;
                if changed != 1 {
                    return Err(RepositoryError::Conflict);
                }
                tx.execute(
                    "UPDATE plugin_invocations SET activation_epoch = ?2
                     WHERE plugin_id = ?1 AND state = 'ambiguous_http'",
                    params![
                        result.plugin_id.as_str(),
                        as_i64(result.new_activation_epoch, "activation epoch")?,
                    ],
                )
                .map_err(storage_error)?;
                if !result.desired_enabled {
                    tx.execute(
                        "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
                         WHERE plugin_id = ?1",
                        params![result.plugin_id.as_str(), now.to_string()],
                    )
                    .map_err(storage_error)?;
                }
            }
            let primary = primary_id
                .as_ref()
                .map(|plugin_id| load_installed_plugin(tx, plugin_id))
                .transpose()?;
            let subject = primary_id.as_ref().map(ToString::to_string);
            Ok(plugin_effect(
                EventType::PLUGIN_HEALTH_CHANGED,
                primary.as_ref(),
                affected,
                subject,
            ))
        },
    )?;
    let outcome = PluginGraphFenceOutcome {
        host_session_id: request.host_session_id,
        results,
        mutation,
    };
    let response_json = serde_json::to_string(&outcome).map_err(storage_error)?;
    if request_json.len().saturating_add(response_json.len()) > RECEIPT_MATERIAL_MAX_BYTES {
        return Err(RepositoryError::OperationTooLarge);
    }
    let changed = transaction
        .execute(
            "UPDATE operation_receipts SET response_json = ?3
             WHERE operation_id = ?1 AND request_json = ?2",
            params![
                request.operation_id.to_string(),
                request_json,
                response_json
            ],
        )
        .map_err(storage_error)?;
    if changed != 1 {
        return Err(RepositoryError::Conflict);
    }
    transaction.commit().map_err(storage_error)?;
    let _ = prune_retained_events(connection);
    Ok(outcome)
}

fn reconciliation_epoch_already_fenced(
    plugin: &InstalledPlugin,
    expired_http: bool,
    dependency_unavailable: bool,
) -> bool {
    !plugin.desired_enabled
        && (plugin.runtime_state == PluginRuntimeState::ReverifyRequired
            || (expired_http
                && plugin.runtime_state == PluginRuntimeState::Suspended
                && plugin.last_error_code.as_deref() == Some("http_ambiguous"))
            || (dependency_unavailable
                && plugin.runtime_state == PluginRuntimeState::Suspended
                && plugin.last_error_code.as_deref() == Some("dependency_failed")))
}

#[derive(Serialize)]
struct ReconciliationHealthTransition {
    plugin_id: PluginId,
    package_generation: u64,
    activation_epoch: u64,
    reason: &'static str,
}

#[derive(Serialize)]
struct ReconciliationHealthRequest<'a> {
    op: &'static str,
    transitions: &'a [ReconciliationHealthTransition],
}

pub(crate) fn reconcile_packages(
    connection: &mut Connection,
    store: &PluginPackageStore,
    now: Timestamp,
) -> Result<PluginPackageReconciliation, RepositoryError> {
    let plugins = load_plugins(connection)?;
    validate_current_graph(connection, &plugins)?;
    if plugins.is_empty() {
        let cleanup = store
            .cleanup_orphans(&HashSet::new())
            .map_err(|error| RepositoryError::Storage(error.to_string()))?;
        return Ok(PluginPackageReconciliation {
            checked: 0,
            disabled: Vec::new(),
            orphan_files_removed: cleanup.removed,
            cleanup_truncated: cleanup.truncated,
        });
    }
    let mut invalid = HashSet::new();
    let mut referenced = HashSet::new();
    for plugin in &plugins {
        referenced.insert(plugin.package_sha256.to_string());
        let valid = store
            .read_authority(&plugin.package_sha256)
            .is_ok_and(|authority| {
                authority.plugin_id() == &plugin.plugin_id
                    && authority.manifest() == &plugin.manifest
                    && authority.package_sha256() == &plugin.package_sha256
                    && authority.component_sha256() == &plugin.component_sha256
                    && authority.publisher_key_id() == &plugin.publisher_key_id
            });
        if !valid {
            invalid.insert(plugin.plugin_id.clone());
        }
    }
    let mut expired_ambiguity = HashSet::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT DISTINCT plugin_id FROM plugin_invocations
                 WHERE state IN ('dispatching_http', 'ambiguous_http') AND retain_until <= ?1",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map([now.to_string()], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        for row in rows {
            expired_ambiguity
                .insert(PluginId::parse(row.map_err(storage_error)?).map_err(storage_error)?);
        }
    }
    let (head, earliest_retained): (i64, Option<i64>) = connection
        .query_row(
            "SELECT global_revision, (SELECT MIN(revision) FROM events)
             FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage_error)?;
    let head = parse_u64(head, "global revision")?;
    let earliest_retained = earliest_retained
        .map(|revision| parse_u64(revision, "retained event revision"))
        .transpose()?;
    let mut retention_lost = HashSet::new();
    for plugin in &plugins {
        let cursor = load_plugin_cursor(connection, &plugin.plugin_id)?;
        if !cursor.resync_required
            && cursor.revision < head
            && earliest_retained.is_none_or(|earliest| {
                cursor
                    .revision
                    .checked_add(1)
                    .is_none_or(|required| earliest > required)
            })
        {
            retention_lost.insert(plugin.plugin_id.clone());
        }
    }
    let mut dependency_impacted = HashSet::new();
    for root in invalid.iter().chain(&expired_ambiguity) {
        for dependent in dependent_closure(&plugins, root) {
            if plugins.iter().any(|plugin| {
                plugin.plugin_id == dependent
                    && (plugin.desired_enabled
                        || plugin.runtime_state != PluginRuntimeState::Disabled)
            }) {
                dependency_impacted.insert(dependent);
            }
        }
    }
    for plugin in &plugins {
        let invalid_package = invalid.contains(&plugin.plugin_id);
        let expired_http = expired_ambiguity.contains(&plugin.plugin_id);
        let dependency_unavailable = dependency_impacted.contains(&plugin.plugin_id);
        let requires_new_epoch = invalid_package
            || expired_http
            || dependency_unavailable
            || plugin.desired_enabled
            || plugin.runtime_state == PluginRuntimeState::ReverifyRequired;
        if requires_new_epoch
            && !reconciliation_epoch_already_fenced(plugin, expired_http, dependency_unavailable)
        {
            next_activation_epoch(plugin.activation_epoch)?;
        }
    }

    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(storage_error)?;
    // A crash after durable pre-send transition is honestly ambiguous. Other
    // in-flight states have no external uncertainty and are abandoned.
    transaction
        .execute(
            "UPDATE plugin_invocations SET state = 'ambiguous_http',
                error_code = 'http_ambiguous'
             WHERE state = 'dispatching_http'",
            [],
        )
        .map_err(storage_error)?;
    transaction
        .execute(
            "DELETE FROM plugin_invocations
             WHERE state IN ('reserved', 'effect_committing')",
            [],
        )
        .map_err(storage_error)?;

    let disabled: BTreeSet<_> = plugins
        .iter()
        .filter(|plugin| {
            invalid.contains(&plugin.plugin_id)
                || expired_ambiguity.contains(&plugin.plugin_id)
                || dependency_impacted.contains(&plugin.plugin_id)
        })
        .map(|plugin| plugin.plugin_id.clone())
        .collect();
    let material_transitions: Vec<_> = plugins
        .iter()
        .filter_map(|plugin| {
            let reason = if expired_ambiguity.contains(&plugin.plugin_id) {
                Some("http_ambiguous")
            } else if dependency_impacted.contains(&plugin.plugin_id) {
                Some("dependency_failed")
            } else {
                None
            }?;
            if reconciliation_epoch_already_fenced(
                plugin,
                reason == "http_ambiguous",
                reason == "dependency_failed",
            ) {
                return None;
            }
            Some(ReconciliationHealthTransition {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                reason,
            })
        })
        .collect();
    let apply_updates = |tx: &Connection| -> Result<(), RepositoryError> {
        for plugin in &plugins {
            let invalid_package = invalid.contains(&plugin.plugin_id);
            let expired_http = expired_ambiguity.contains(&plugin.plugin_id);
            let lost_events = retention_lost.contains(&plugin.plugin_id);
            let dependency_unavailable = dependency_impacted.contains(&plugin.plugin_id);
            let restart_activation = plugin.desired_enabled
                || plugin.runtime_state == PluginRuntimeState::ReverifyRequired;
            if !invalid_package
                && !expired_http
                && !lost_events
                && !dependency_unavailable
                && !restart_activation
            {
                continue;
            }
            let requires_new_epoch = invalid_package
                || expired_http
                || dependency_unavailable
                || plugin.desired_enabled
                || plugin.runtime_state == PluginRuntimeState::ReverifyRequired;
            let epoch = if !requires_new_epoch
                || reconciliation_epoch_already_fenced(plugin, expired_http, dependency_unavailable)
            {
                plugin.activation_epoch
            } else {
                next_activation_epoch(plugin.activation_epoch)?
            };
            let (desired_enabled, runtime_state, failure_count, error_code, next_retry_at) =
                if invalid_package {
                    (false, "reverify_required", 3, Some("package_invalid"), None)
                } else if expired_http {
                    (false, "suspended", 3, Some("http_ambiguous"), None)
                } else if dependency_unavailable {
                    (false, "suspended", 3, Some("dependency_failed"), None)
                } else if plugin.desired_enabled
                    && matches!(
                        plugin.runtime_state,
                        PluginRuntimeState::Degraded | PluginRuntimeState::Failed
                    )
                {
                    (
                        true,
                        if plugin.runtime_state == PluginRuntimeState::Degraded {
                            "degraded"
                        } else {
                            "failed"
                        },
                        i64::from(plugin.failure_count),
                        plugin.last_error_code.as_deref(),
                        plugin.next_retry_at.map(|retry_at| retry_at.to_string()),
                    )
                } else if plugin.desired_enabled
                    && plugin.runtime_state == PluginRuntimeState::Starting
                    && plugin.failure_count > 0
                {
                    (
                        true,
                        "starting",
                        i64::from(plugin.failure_count),
                        plugin.last_error_code.as_deref(),
                        None,
                    )
                } else {
                    (
                        plugin.desired_enabled,
                        if plugin.desired_enabled {
                            "starting"
                        } else {
                            "disabled"
                        },
                        0,
                        None,
                        None,
                    )
                };
            let authority_timestamp = if now < plugin.updated_at {
                plugin.updated_at
            } else {
                now
            };
            tx.execute(
                "UPDATE plugins SET activation_epoch = ?2, desired_enabled = ?3,
                        runtime_state = ?4, failure_count = ?5, last_error_code = ?6,
                        next_retry_at = ?7, updated_at = ?8 WHERE plugin_id = ?1",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(epoch, "activation epoch")?,
                    i64::from(desired_enabled),
                    runtime_state,
                    failure_count,
                    error_code,
                    next_retry_at,
                    authority_timestamp.to_string(),
                ],
            )
            .map_err(storage_error)?;
            if expired_http {
                tx.execute(
                    "DELETE FROM plugin_invocations
                         WHERE plugin_id = ?1 AND state = 'ambiguous_http' AND retain_until <= ?2",
                    params![plugin.plugin_id.as_str(), now.to_string()],
                )
                .map_err(storage_error)?;
            }
            // Even when code, a dependency, or one older delivery becomes unavailable,
            // every still-retained HTTP ambiguity keeps its stable delivery identity.
            tx.execute(
                "UPDATE plugin_invocations SET activation_epoch = ?2
                     WHERE plugin_id = ?1 AND state = 'ambiguous_http'",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(epoch, "activation epoch")?,
                ],
            )
            .map_err(storage_error)?;
            if invalid_package || expired_http || lost_events || dependency_unavailable {
                tx.execute(
                    "UPDATE plugin_event_cursors SET resync_required = 1, updated_at = ?2
                         WHERE plugin_id = ?1",
                    params![plugin.plugin_id.as_str(), now.to_string()],
                )
                .map_err(storage_error)?;
            }
        }
        Ok(())
    };
    let mut material_commit = None;
    if material_transitions.is_empty() {
        apply_updates(&transaction)?;
    } else {
        let request = canonical_json(&ReconciliationHealthRequest {
            op: "reconcile_plugin_health",
            transitions: &material_transitions,
        })?;
        let operation_id =
            derived_operation_id(b"junban.plugin.reconcile-health.v1\0", request.as_bytes());
        let affected: Vec<_> = material_transitions
            .iter()
            .map(|transition| transition.plugin_id.clone())
            .collect();
        let primary_id = affected.first().cloned();
        material_commit = Some(mutate_in_transaction(
            &transaction,
            operation_id,
            request,
            now,
            |tx, _| {
                apply_updates(tx)?;
                let primary = primary_id
                    .as_ref()
                    .map(|plugin_id| load_installed_plugin(tx, plugin_id))
                    .transpose()?;
                Ok(plugin_effect(
                    EventType::PLUGIN_HEALTH_CHANGED,
                    primary.as_ref(),
                    affected,
                    Some("plugin reconciliation changed material health".to_owned()),
                ))
            },
        )?);
    }
    transaction.commit().map_err(storage_error)?;
    if material_commit.is_some_and(|committed| committed.newly_committed) {
        let _ = prune_retained_events(connection);
    }
    let cleanup = store
        .cleanup_orphans(&referenced)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(PluginPackageReconciliation {
        checked: plugins.len(),
        disabled: disabled.into_iter().collect(),
        orphan_files_removed: cleanup.removed,
        cleanup_truncated: cleanup.truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::{Read as _, Seek as _},
        path::PathBuf,
    };

    use ed25519_dalek::SigningKey;
    use junban_app::{
        AuthorizedCommitPluginInvocationRequest, CommitPluginInvocationRequest,
        FinalizePluginResyncRequest, MoveTarget, OrderAnchor, PlannedPluginInvocationCommit,
        PluginAttemptFailureCause, PluginComponentSelection, PluginCursorRetentionLossAuthority,
        PluginDeliveryAuthority, PluginDomainEffect, PluginGraphFenceEntry, PluginPackageAuthority,
        PluginRepository, PluginResyncTranscript, ProjectDraft, ProjectPatch, Repository,
        SetPluginSettingRequest, StagedFile, plan_authorized_plugin_invocation_commit,
    };
    use junban_domain::{
        EntityName, HexColor, ProjectId, SortOrder, TagId, TagName, TaskDraft, TaskId, TaskTitle,
    };
    use junban_plugin_sdk::{
        Capability, CommandDeclaration, Dependency, EventKind, EventScope, HttpMethod, HttpOrigin,
        HttpScope, InvocationOutcome, InvocationRequest, Permission, PermissionScope, Publisher,
        RuntimeProfile, SettingDeclaration, SettingSchema, SurfaceDeclaration, SurfaceKind,
        SurfaceLocation, UnscopedPermission, WitAuthority, pack_package,
        private_body_types::{
            ByteList, CommandCall, EventEnvelope, EventSubject, FinalKvChoice, FinalizeResync,
            FinalizedResync, FlushAck, FlushStagedKv, FlushState, KvOperation, KvSegment, KvSet,
            ResourceKind, ResyncPage as PrivateResyncPage, ResyncPageOutcome, SnapshotAck,
            SnapshotPage, SnapshotRecords, WitResult,
        },
        signer_key_id,
    };
    use uuid::Uuid;

    use super::*;
    use crate::tx::global_revision;

    const KEY_BYTES: [u8; 32] = [23; 32];
    static PACKAGE_MEMORY_TEST_ACTIVE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    struct PackageMemoryTestGuard;

    impl PackageMemoryTestGuard {
        fn acquire() -> Self {
            while PACKAGE_MEMORY_TEST_ACTIVE
                .compare_exchange(
                    false,
                    true,
                    std::sync::atomic::Ordering::AcqRel,
                    std::sync::atomic::Ordering::Acquire,
                )
                .is_err()
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Self
        }
    }

    impl Drop for PackageMemoryTestGuard {
        fn drop(&mut self) {
            PACKAGE_MEMORY_TEST_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
        }
    }

    struct TestProfile {
        path: PathBuf,
    }

    impl TestProfile {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("junban-plugin-{}", Uuid::now_v7()));
            fs::create_dir(&path).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            }
            Self { path }
        }

        fn connection(&self) -> Connection {
            crate::open_connection(&self.path.join("junban.sqlite3")).unwrap()
        }
    }

    impl Drop for TestProfile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn encode_leb(mut value: usize, output: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            output.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    const fn leb_len(mut value: usize) -> usize {
        let mut len = 1;
        while value >= 0x80 {
            value >>= 7;
            len += 1;
        }
        len
    }

    fn component_with_size(target: usize) -> Vec<u8> {
        let base = include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");
        let available_padding = target
            .checked_sub(base.len())
            .expect("synthetic component target must exceed the retained component");
        let search_start = available_padding
            .checked_sub(64)
            .expect("synthetic component target must leave room for encoded padding");
        let data_len = (search_start..available_padding)
            .find(|data_len| {
                let payload_len = 2 + leb_len(*data_len) + data_len;
                let module_len = 8 + 1 + leb_len(payload_len) + payload_len;
                base.len() + 1 + leb_len(module_len) + module_len == target
            })
            .expect("component padding has an exact bounded encoding");
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut payload = vec![1, 1]; // one passive data segment
        encode_leb(data_len, &mut payload);
        payload.resize(payload.len() + data_len, 0);
        module.push(11); // core data section
        encode_leb(payload.len(), &mut module);
        module.extend(payload);
        let mut component = Vec::with_capacity(target);
        component.extend_from_slice(base);
        component.push(1); // component core-module section
        encode_leb(module.len(), &mut component);
        component.extend(module);
        assert_eq!(component.len(), target);
        component
    }

    fn stage_bytes(bytes: &[u8]) -> StagedFile {
        let path = std::env::temp_dir().join(format!("junban-plugin-stage-{}", Uuid::now_v7()));
        fs::write(&path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        StagedFile::new(path, bytes.len() as u64)
    }

    fn stage_sparse_package(len: u64) -> StagedFile {
        let path = std::env::temp_dir().join(format!("junban-plugin-stage-{}", Uuid::now_v7()));
        let file = fs::File::create(&path).unwrap();
        file.set_len(len).unwrap();
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        StagedFile::new(path, len)
    }

    #[cfg(target_os = "linux")]
    fn resident_kib() -> u64 {
        fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("VmRSS:")?
                    .split_whitespace()
                    .next()?
                    .parse()
                    .ok()
            })
            .unwrap()
    }

    fn publish_bytes(
        store: &PluginPackageStore,
        bytes: &[u8],
    ) -> Result<PluginPackageAuthority, crate::package_store::PackageStoreError> {
        store.publish(stage_bytes(bytes))
    }

    fn plan_result(
        request: CommitPluginInvocationRequest,
    ) -> Result<PlannedPluginInvocationCommit, RepositoryError> {
        let authority = PluginDeliveryAuthority {
            plugin_id: request.plugin_id.clone(),
            package_generation: request.package_generation.max(1),
            activation_epoch: request.activation_epoch.max(1),
            host_session_id: OperationId::new(),
            invocation_id: request.invocation_operation_id,
            payload_sha256: Sha256Digest::of(b"storage planner test"),
            mode: PluginDeliveryMode::Active,
        };
        let delivery = PluginInvocationDelivery::new(
            authority,
            PluginHookKind::InvokeCommand,
            PluginId::parse("storage-plan-test").unwrap(),
        )
        .unwrap();
        plan_authorized_plugin_invocation_commit(AuthorizedCommitPluginInvocationRequest {
            request,
            delivery,
        })
        .map(|planned| planned.planned)
    }

    fn plan(request: CommitPluginInvocationRequest) -> PlannedPluginInvocationCommit {
        plan_result(request).unwrap()
    }

    fn record_failure(
        connection: &mut Connection,
        plugin: &InstalledPlugin,
        cause: PluginAttemptFailureCause,
        now: Timestamp,
    ) -> Result<InstalledPlugin, RepositoryError> {
        let plugin_id = plugin.plugin_id.clone();
        record_plugin_attempt_failure(
            connection,
            OperationId::new(),
            RecordPluginAttemptFailureRequest {
                plugin_id: plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                cause,
            },
            now,
        )?;
        get_installed_plugin(connection, plugin_id)
    }

    fn retry_due(
        connection: &mut Connection,
        plugin: &InstalledPlugin,
        now: Timestamp,
    ) -> Result<InstalledPlugin, RepositoryError> {
        let plugin_id = plugin.plugin_id.clone();
        retry_due_plugin(
            connection,
            OperationId::new(),
            DuePluginRetryRequest {
                plugin_id: plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_runtime_state: plugin.runtime_state,
                expected_next_retry_at: plugin.next_retry_at.ok_or(RepositoryError::Conflict)?,
            },
            now,
        )?;
        get_installed_plugin(connection, plugin_id)
    }

    fn reserve_ambiguous(
        connection: &mut Connection,
        request: ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> OperationId {
        let operation_id = request.operation_id;
        let plugin_id = request.plugin_id.clone();
        let package_generation = request.package_generation;
        let activation_epoch = request.activation_epoch;
        reserve_invocation_for_test(connection, request, now).unwrap();
        for (expected_state, next_state) in [
            (
                PluginInvocationState::Reserved,
                PluginInvocationState::DispatchingHttp,
            ),
            (
                PluginInvocationState::DispatchingHttp,
                PluginInvocationState::AmbiguousHttp,
            ),
        ] {
            transition_invocation_for_test(
                connection,
                TransitionPluginInvocationRequest {
                    operation_id,
                    plugin_id: plugin_id.clone(),
                    package_generation,
                    activation_epoch,
                    expected_state,
                    next_state,
                },
                now,
            )
            .unwrap();
        }
        operation_id
    }

    fn package(id: &str, version: &str) -> (Vec<u8>, PluginPackageAuthority, [u8; 32]) {
        package_with_dependencies(id, version, Vec::new())
    }

    fn package_with_dependencies(
        id: &str,
        version: &str,
        dependencies: Vec<Dependency>,
    ) -> (Vec<u8>, PluginPackageAuthority, [u8; 32]) {
        package_with_key(id, version, dependencies, &KEY_BYTES)
    }

    fn package_with_key(
        id: &str,
        version: &str,
        dependencies: Vec<Dependency>,
        key_bytes: &[u8; 32],
    ) -> (Vec<u8>, PluginPackageAuthority, [u8; 32]) {
        package_with_key_and_events(
            id,
            version,
            dependencies,
            key_bytes,
            vec![EventKind::TaskCreated],
        )
    }

    fn package_with_key_and_events(
        id: &str,
        version: &str,
        dependencies: Vec<Dependency>,
        key_bytes: &[u8; 32],
        subscriptions: Vec<EventKind>,
    ) -> (Vec<u8>, PluginPackageAuthority, [u8; 32]) {
        package_with_surfaces(
            id,
            version,
            dependencies,
            key_bytes,
            subscriptions,
            Vec::new(),
        )
    }

    fn package_with_surfaces(
        id: &str,
        version: &str,
        dependencies: Vec<Dependency>,
        key_bytes: &[u8; 32],
        subscriptions: Vec<EventKind>,
        surfaces: Vec<SurfaceDeclaration>,
    ) -> (Vec<u8>, PluginPackageAuthority, [u8; 32]) {
        let component = include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");
        let key = SigningKey::from_bytes(key_bytes);
        let public_key = key.verifying_key().to_bytes();
        let unscoped = |capability| Permission {
            capability,
            scope: PermissionScope::Unscoped(UnscopedPermission {}),
        };
        let mut permissions = vec![
            unscoped(Capability::Commands),
            Permission {
                capability: Capability::EventsSubscribe,
                scope: PermissionScope::Events(EventScope {
                    event_kinds: subscriptions.clone(),
                }),
            },
        ];
        permissions.extend([
            Permission {
                capability: Capability::Http,
                scope: PermissionScope::Http(HttpScope {
                    origins: vec![HttpOrigin("https://example.test".to_owned())],
                    methods: vec![HttpMethod::Post],
                }),
            },
            unscoped(Capability::Logging),
            unscoped(Capability::ProjectsRead),
            unscoped(Capability::Settings),
            unscoped(Capability::Storage),
            unscoped(Capability::TagsRead),
            unscoped(Capability::TasksRead),
            unscoped(Capability::TasksWrite),
        ]);
        if surfaces
            .iter()
            .any(|surface| surface.kind == SurfaceKind::Panel)
        {
            permissions.push(unscoped(Capability::UiPanel));
        }
        if surfaces
            .iter()
            .any(|surface| surface.kind == SurfaceKind::View)
        {
            permissions.push(unscoped(Capability::UiView));
        }
        let manifest = RuntimeManifest {
            schema_version: 1,
            id: id.to_owned(),
            name: "Plugin test".to_owned(),
            description: "Storage authority fixture".to_owned(),
            version: version.to_owned(),
            publisher: Publisher {
                id: "test-publisher".to_owned(),
                name: "Test Publisher".to_owned(),
                key_id: signer_key_id(&public_key).to_string(),
            },
            license: "MIT".to_owned(),
            junban_compatibility: "^0.1".to_owned(),
            wit: WitAuthority {
                package: "junban:plugin".to_owned(),
                world: "plugin".to_owned(),
                version: "0.1.0".to_owned(),
            },
            runtime_profile: RuntimeProfile::Rust,
            component_sha256: Sha256Digest::of(component).to_string(),
            permissions,
            dependencies,
            commands: vec![CommandDeclaration {
                id: "run".to_owned(),
                title: "Run".to_owned(),
                description: "Run fixture".to_owned(),
                icon: None,
                inputs: Vec::new(),
            }],
            subscriptions,
            surfaces,
            settings: {
                let mut settings = vec![SettingDeclaration {
                    id: "enabled".to_owned(),
                    label: "Enabled".to_owned(),
                    description: "Fixture setting".to_owned(),
                    schema: SettingSchema::Boolean { default: false },
                }];
                settings.extend((0..8).map(|index| SettingDeclaration {
                    id: format!("large-{index}"),
                    label: format!("Large {index}"),
                    description: "Aggregate-bound fixture setting".to_owned(),
                    schema: SettingSchema::Text {
                        default: String::new(),
                        min_bytes: 0,
                        max_bytes: 8_192,
                        secret: false,
                    },
                }));
                settings
            },
            services: Vec::new(),
        };
        let bytes = pack_package(&manifest, component, &key).unwrap();
        let authority = PluginPackageAuthority::inspect(&bytes).unwrap();
        (bytes, authority, public_key)
    }

    fn activate_plugin(
        connection: &mut Connection,
        store: &PluginPackageStore,
        plugin: &InstalledPlugin,
        now: Timestamp,
    ) -> InstalledPlugin {
        if !plugin.desired_enabled {
            set_plugin_desired_enabled(
                connection,
                store,
                OperationId::new(),
                plugin.plugin_id.clone(),
                true,
                now,
            )
            .unwrap();
        }
        let starting = get_installed_plugin(connection, plugin.plugin_id.clone()).unwrap();
        connection
            .execute(
                "UPDATE plugin_event_cursors
                 SET revision = (SELECT global_revision FROM app_state WHERE singleton = 1),
                     resync_required = 0, updated_at = ?2
                 WHERE plugin_id = ?1",
                params![starting.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        complete_plugin_activation(
            connection,
            OperationId::new(),
            CompletePluginActivationRequest {
                plugin_id: starting.plugin_id.clone(),
                package_generation: starting.package_generation,
                activation_epoch: starting.activation_epoch,
            },
            now,
        )
        .unwrap();
        get_installed_plugin(connection, starting.plugin_id).unwrap()
    }

    fn grant_capabilities(
        connection: &mut Connection,
        plugin: &InstalledPlugin,
        capabilities: &[Capability],
        now: Timestamp,
    ) -> InstalledPlugin {
        let permissions = plugin
            .manifest
            .permissions
            .iter()
            .filter(|permission| capabilities.contains(&permission.capability))
            .cloned()
            .collect();
        replace_plugin_grants(
            connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                plugin.plugin_id.clone(),
                plugin.package_generation,
                &plugin.manifest.permissions,
                permissions,
            )
            .unwrap(),
            now,
        )
        .unwrap();
        get_installed_plugin(connection, plugin.plugin_id.clone()).unwrap()
    }

    fn authorized_reservation(
        plugin: &InstalledPlugin,
        operation_id: OperationId,
        hook_kind: PluginHookKind,
        entry: PluginManifestEntry,
        mode: PluginDeliveryMode,
        payload_sha256: Sha256Digest,
        resync_session: Option<PluginResyncSession>,
    ) -> AuthorizedReservePluginInvocationRequest {
        let entry_authority = plugin_manifest_entry_authority(
            &plugin.manifest,
            hook_kind,
            PluginManifestEntrySelector::Requested(&entry),
        )
        .unwrap();
        let delivery = PluginInvocationDelivery::new(
            junban_app::PluginDeliveryAuthority {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: OperationId::new(),
                invocation_id: operation_id,
                payload_sha256,
                mode,
            },
            hook_kind,
            entry_authority.persisted_id,
        )
        .unwrap();
        AuthorizedReservePluginInvocationRequest {
            request: ReservePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind,
                entry,
                request_sha256: delivery.request_sha256.clone(),
                delivery_operation_id: OperationId::new(),
                resync_session,
            },
            delivery,
        }
    }

    fn encode_resync_request(page: PrivateResyncPage) -> Vec<u8> {
        serde_json::to_vec(&InvocationRequest::resync(Some("resync".to_owned()), page)).unwrap()
    }

    fn encode_resync_outcome(page: ResyncPageOutcome) -> Vec<u8> {
        serde_json::to_vec(&InvocationOutcome::Resync(WitResult::Ok(page))).unwrap()
    }

    fn prepare_finalize_request(
        connection: &mut Connection,
        store: &PluginPackageStore,
        now: Timestamp,
        staged: Vec<(String, Vec<u8>)>,
        choice: FinalKvChoice,
    ) -> (FinalizePluginResyncRequest, InstalledPlugin, u64) {
        let installed = install_fixture(connection, store, now);
        let granted = grant_capabilities(connection, &installed, &[Capability::Storage], now);
        set_plugin_desired_enabled(
            connection,
            store,
            OperationId::new(),
            granted.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let plugin = get_installed_plugin(connection, granted.plugin_id).unwrap();
        prepare_finalize_for_plugin(connection, plugin, now, staged, choice)
    }

    fn prepare_finalize_for_plugin(
        connection: &mut Connection,
        plugin: InstalledPlugin,
        now: Timestamp,
        staged: Vec<(String, Vec<u8>)>,
        choice: FinalKvChoice,
    ) -> (FinalizePluginResyncRequest, InstalledPlugin, u64) {
        let operation_id = OperationId::new();
        let session = open_plugin_resync_session(
            connection,
            BeginPluginResyncRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
            },
            now,
        )
        .unwrap();
        let authorized = authorized_reservation(
            &plugin,
            operation_id,
            PluginHookKind::Resync,
            PluginManifestEntry::Resync,
            PluginDeliveryMode::StartingResync,
            plugin_resync_request_hash(&session),
            Some(session.clone()),
        );
        let mut transcript =
            PluginResyncTranscript::new(authorized.delivery.clone(), session.clone()).unwrap();
        for (index, kind) in [
            PluginSnapshotKind::Task,
            PluginSnapshotKind::Project,
            PluginSnapshotKind::Tag,
        ]
        .into_iter()
        .enumerate()
        {
            let request = PluginResyncPageRequest {
                session: session.clone(),
                kind,
                after_id: None,
            };
            let page = list_plugin_resync_page(connection, request.clone(), now).unwrap();
            assert!(page.items.is_empty());
            assert!(page.exhausted);
            let resource_kind = match kind {
                PluginSnapshotKind::Task => ResourceKind::Task,
                PluginSnapshotKind::Project => ResourceKind::Project,
                PluginSnapshotKind::Tag => ResourceKind::Tag,
            };
            let records = match kind {
                PluginSnapshotKind::Task => SnapshotRecords::Tasks(Vec::new()),
                PluginSnapshotKind::Project => SnapshotRecords::Projects(Vec::new()),
                PluginSnapshotKind::Tag => SnapshotRecords::Tags(Vec::new()),
            };
            let request_body = encode_resync_request(PrivateResyncPage::Snapshot(SnapshotPage {
                session_id: operation_id.to_string(),
                event_epoch: session.snapshot_event_epoch.clone(),
                head_revision: session.snapshot_revision,
                kind: resource_kind,
                page_index: u32::try_from(index).unwrap(),
                records,
                final_snapshot_page: kind == PluginSnapshotKind::Tag,
            }));
            let outcome_body = encode_resync_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: operation_id.to_string(),
                page_index: u32::try_from(index).unwrap(),
                kind: resource_kind,
                segment: None,
            }));
            transcript
                .record_snapshot(&request, &page, &request_body, &outcome_body)
                .unwrap();
        }
        let segment = if staged.is_empty() {
            None
        } else {
            Some(KvSegment {
                operations: staged
                    .iter()
                    .map(|(key, value)| {
                        KvOperation::Set(KvSet {
                            key: key.clone(),
                            value: ByteList::new(value.clone()).unwrap(),
                        })
                    })
                    .collect(),
            })
        };
        let flush_request =
            encode_resync_request(PrivateResyncPage::FlushStagedKv(FlushStagedKv {
                session_id: operation_id.to_string(),
                request_index: 0,
            }));
        let flush_outcome = encode_resync_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id: operation_id.to_string(),
            request_index: 0,
            segment,
            state: FlushState::Complete,
        }));
        transcript
            .record_flush(&flush_request, &flush_outcome)
            .unwrap();
        let finalize_request = encode_resync_request(PrivateResyncPage::Finalize(FinalizeResync {
            session_id: operation_id.to_string(),
        }));
        let finalize_outcome =
            encode_resync_outcome(ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: operation_id.to_string(),
                choice,
            }));
        transcript
            .record_finalize(&finalize_request, &finalize_outcome)
            .unwrap();
        let finalize = transcript.into_finalize_request().unwrap();
        reserve_authorized_plugin_invocation(connection, authorized.clone(), now).unwrap();
        transition_authorized_plugin_invocation(
            connection,
            AuthorizedTransitionPluginInvocationRequest {
                request: TransitionPluginInvocationRequest {
                    operation_id,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected_state: PluginInvocationState::Reserved,
                    next_state: PluginInvocationState::EffectCommitting,
                },
                delivery: authorized.delivery.clone(),
            },
            now,
        )
        .unwrap();
        let snapshot_revision = session.snapshot_revision;
        (finalize, plugin, snapshot_revision)
    }

    fn authorized_retained_event_reservation(
        connection: &Connection,
        plugin: &InstalledPlugin,
        operation_id: OperationId,
        mode: PluginDeliveryMode,
    ) -> AuthorizedReservePluginInvocationRequest {
        let cursor = get_plugin_cursor(connection, plugin.plugin_id.clone()).unwrap();
        let source_revision = cursor.revision.checked_add(1).unwrap();
        let event = load_exact_retained_event(connection, source_revision).unwrap();
        let entry_id = PluginId::parse("task-created").unwrap();
        let body = serde_json::to_vec(&InvocationRequest::handle_event(
            Some(entry_id.to_string()),
            EventEnvelope {
                event_epoch: cursor.event_epoch.clone(),
                revision: source_revision,
                kind: junban_plugin_sdk::private_body_types::EventKind::TaskCreated,
                subject: EventSubject::DeletedTask(TaskId::new().to_string()),
            },
        ))
        .unwrap();
        let expected_cursor = PluginCursorPosition::from(&cursor);
        let next_cursor = PluginCursorPosition {
            event_epoch: cursor.event_epoch,
            revision: source_revision,
            resync_required: false,
        };
        let source =
            junban_app::PluginRetainedEventSource::new(&event, expected_cursor, next_cursor, body)
                .unwrap();
        let payload_sha256 = plugin_retained_event_payload_hash(
            &source.event_content_sha256,
            entry_id.as_str(),
            source.private_body(),
        )
        .unwrap();
        let delivery = PluginInvocationDelivery::for_retained_event(
            junban_app::PluginDeliveryAuthority {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: OperationId::new(),
                invocation_id: operation_id,
                payload_sha256,
                mode,
            },
            entry_id.clone(),
            source,
        )
        .unwrap();
        AuthorizedReservePluginInvocationRequest {
            request: ReservePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::HandleEvent,
                entry: PluginManifestEntry::Event { event_id: entry_id },
                request_sha256: delivery.request_sha256.clone(),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            },
            delivery,
        }
    }

    fn event_cursor_request(
        plugin: &InstalledPlugin,
        delivery: &PluginInvocationDelivery,
    ) -> AdvancePluginCursorRequest {
        let source = delivery.retained_event_source().unwrap();
        AdvancePluginCursorRequest {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            expected: source.expected_cursor.clone(),
            next: source.next_cursor.clone(),
        }
    }

    fn mutated_event_deliveries(
        delivery: &PluginInvocationDelivery,
    ) -> Vec<PluginInvocationDelivery> {
        let mut source_revision = delivery.clone();
        source_revision
            .retained_event_source
            .as_mut()
            .unwrap()
            .source_revision += 1;
        let mut content_hash = delivery.clone();
        content_hash
            .retained_event_source
            .as_mut()
            .unwrap()
            .event_content_sha256 = Sha256Digest::of(b"changed retained event");
        let mut expected_cursor = delivery.clone();
        expected_cursor
            .retained_event_source
            .as_mut()
            .unwrap()
            .expected_cursor
            .revision += 1;
        let mut next_cursor = delivery.clone();
        next_cursor
            .retained_event_source
            .as_mut()
            .unwrap()
            .next_cursor
            .revision += 1;
        vec![source_revision, content_hash, expected_cursor, next_cursor]
    }

    fn verified_skip_request(
        connection: &Connection,
        plugin: &InstalledPlugin,
        mode: PluginDeliveryMode,
        classification: PluginRetainedEventClassification,
    ) -> VerifiedPluginCursorSkipRequest {
        let cursor = get_plugin_cursor(connection, plugin.plugin_id.clone()).unwrap();
        let source_revision = cursor.revision + 1;
        let event = load_exact_retained_event(connection, source_revision).unwrap();
        VerifiedPluginCursorSkipRequest {
            authority: junban_app::PluginCursorSkipAuthority {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: OperationId::new(),
                mode,
            },
            source_revision,
            event_content_sha256: plugin_committed_event_content_hash(&event).unwrap(),
            expected_cursor: PluginCursorPosition::from(&cursor),
            next_cursor: PluginCursorPosition {
                event_epoch: cursor.event_epoch,
                revision: source_revision,
                resync_required: false,
            },
            classification,
        }
    }

    fn retention_test_invocation_request(
        plugin: &InstalledPlugin,
        operation_id: OperationId,
        delivery_operation_id: OperationId,
    ) -> ReservePluginInvocationRequest {
        ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::HandleEvent,
            entry: PluginManifestEntry::Event {
                event_id: PluginId::parse("task-created").unwrap(),
            },
            request_sha256: Sha256Digest::of(operation_id.as_uuid().as_bytes()),
            delivery_operation_id,
            resync_session: None,
        }
    }

    fn retention_loss_request(
        plugin: &InstalledPlugin,
        cursor: &PluginEventCursor,
        operation_id: OperationId,
        host_session_id: OperationId,
        mode: PluginDeliveryMode,
    ) -> MarkPluginRetentionLossRequest {
        MarkPluginRetentionLossRequest {
            operation_id,
            authority: PluginCursorRetentionLossAuthority {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id,
                mode,
            },
            expected_cursor: PluginCursorPosition::from(cursor),
        }
    }

    fn invalidating_event_request(
        connection: &Connection,
        plugin: &InstalledPlugin,
        cursor: &PluginEventCursor,
        operation_id: OperationId,
        host_session_id: OperationId,
        mode: PluginDeliveryMode,
    ) -> MarkPluginInvalidatingEventRequest {
        let source_revision = cursor.revision + 1;
        let event = load_exact_retained_event(connection, source_revision).unwrap();
        MarkPluginInvalidatingEventRequest {
            operation_id,
            authority: junban_app::PluginInvalidatingEventAuthority {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id,
                mode,
            },
            expected_cursor: PluginCursorPosition::from(cursor),
            source_revision,
            event_content_sha256: plugin_committed_event_content_hash(&event).unwrap(),
        }
    }

    fn append_invalidating_task_move(connection: &mut Connection, task_id: TaskId, now: Timestamp) {
        task_ops::move_task(
            connection,
            OperationId::new(),
            task_id,
            MoveTarget {
                parent_id: None,
                project_id: None,
                section_id: None,
                order: OrderAnchor::Keep,
            },
            now,
        )
        .unwrap();
    }

    fn make_latest_event_malformed_direct(connection: &Connection, revision: u64) {
        let mut event = load_exact_retained_event(connection, revision).unwrap();
        event.event_type = EventType::new(EventType::TASK_CREATED);
        event.primary = None;
        event.snapshot = None;
        connection
            .execute(
                "UPDATE events SET event_type = ?2, event_json = ?3 WHERE revision = ?1",
                params![
                    as_i64(revision, "event revision").unwrap(),
                    EventType::TASK_CREATED,
                    serde_json::to_string(&event).unwrap(),
                ],
            )
            .unwrap();
    }

    fn create_retention_gap(
        connection: &mut Connection,
        cursor: &PluginEventCursor,
        now: Timestamp,
    ) -> u64 {
        set_community_plugin_policy(connection, OperationId::new(), false, now).unwrap();
        set_community_plugin_policy(connection, OperationId::new(), true, now).unwrap();
        let head = global_revision(connection).unwrap();
        assert!(head > cursor.revision + 1);
        connection
            .execute(
                "DELETE FROM events WHERE revision < ?1",
                [as_i64(head, "global revision").unwrap()],
            )
            .unwrap();
        assert!(load_exact_retained_event(connection, cursor.revision + 1).is_err());
        head
    }

    fn append_irrelevant_settings_event(connection: &mut Connection, now: Timestamp, accent: &str) {
        let mut appearance = crate::settings_ops::get_settings(connection)
            .unwrap()
            .appearance;
        appearance.accent = HexColor::new(accent).unwrap();
        crate::settings_ops::patch_settings(
            connection,
            OperationId::new(),
            junban_app::SettingsPatch {
                appearance: Some(appearance),
                ..junban_app::SettingsPatch::default()
            },
            now,
        )
        .unwrap();
    }

    fn install_fixture(
        connection: &mut Connection,
        store: &PluginPackageStore,
        now: Timestamp,
    ) -> InstalledPlugin {
        install_named_fixture(connection, store, "test-plugin", Vec::new(), now)
    }

    fn install_named_fixture(
        connection: &mut Connection,
        store: &PluginPackageStore,
        plugin_id: &str,
        dependencies: Vec<Dependency>,
        now: Timestamp,
    ) -> InstalledPlugin {
        let (bytes, authority, public_key) =
            package_with_dependencies(plugin_id, "1.0.0", dependencies);
        assert_eq!(publish_bytes(store, &bytes).unwrap(), authority);
        let trusted: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM plugin_publisher_trust WHERE status = 'active')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        if !trusted {
            trust_publisher(
                connection,
                OperationId::new(),
                TrustPublisherRequest::new(public_key),
                now,
            )
            .unwrap();
            set_community_plugin_policy(connection, OperationId::new(), true, now).unwrap();
        }
        let result = install_plugin(
            connection,
            store,
            OperationId::new(),
            InstallPluginRequest {
                package: authority,
                source: PluginInstallSource::CommunityRegistry,
                replace_existing: false,
                allow_downgrade: false,
            },
            now,
        )
        .unwrap();
        match result {
            PluginMutationOutcome::Committed(_) => {}
            other => panic!("unexpected install outcome: {other:?}"),
        }
        get_installed_plugin(connection, PluginId::parse(plugin_id).unwrap()).unwrap()
    }

    fn component_selection(plugin: &InstalledPlugin) -> PluginComponentSelection {
        PluginComponentSelection {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
        }
    }

    fn active_dependency_graph(
        connection: &mut Connection,
        store: &PluginPackageStore,
        now: Timestamp,
    ) -> (InstalledPlugin, InstalledPlugin) {
        let dependency =
            install_named_fixture(connection, store, "zzz-dependency", Vec::new(), now);
        let dependent = install_named_fixture(
            connection,
            store,
            "aaa-dependent",
            vec![Dependency {
                id: dependency.plugin_id.to_string(),
                requirement: "^1.0".to_owned(),
                services: Vec::new(),
            }],
            now,
        );
        let dependency = grant_capabilities(
            connection,
            &dependency,
            &[Capability::Logging, Capability::TasksRead],
            now,
        );
        let dependent = grant_capabilities(
            connection,
            &dependent,
            &[Capability::Commands, Capability::TasksWrite],
            now,
        );
        let dependency = activate_plugin(connection, store, &dependency, now);
        let dependent = activate_plugin(connection, store, &dependent, now);
        (dependent, dependency)
    }

    fn write_private_package(path: &std::path::Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[test]
    fn opened_component_sources_bind_dependency_order_grants_and_exact_component() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_260, 0);
        let (dependent, dependency) = active_dependency_graph(&mut connection, &store, now);
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting'
                 WHERE plugin_id = ?1",
                [dependent.plugin_id.as_str()],
            )
            .unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let mut sources = open_plugin_component_sources(
            &mut connection,
            &store,
            vec![
                component_selection(&dependent),
                component_selection(&dependency),
            ],
        )
        .unwrap();
        assert_eq!(
            sources
                .iter()
                .map(|source| source.plugin_id().as_str())
                .collect::<Vec<_>>(),
            ["zzz-dependency", "aaa-dependent"]
        );
        let component = include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");
        for source in &mut sources {
            let installed = if source.plugin_id() == &dependency.plugin_id {
                &dependency
            } else {
                &dependent
            };
            let expected_grants: Vec<_> = installed
                .manifest
                .permissions
                .iter()
                .filter(|permission| {
                    if installed.plugin_id == dependency.plugin_id {
                        matches!(
                            permission.capability,
                            Capability::Logging | Capability::TasksRead
                        )
                    } else {
                        matches!(
                            permission.capability,
                            Capability::Commands | Capability::TasksWrite
                        )
                    }
                })
                .cloned()
                .collect();
            let inspection =
                junban_plugin_sdk::inspect_component(component, &installed.manifest).unwrap();
            assert_eq!(source.package_generation(), installed.package_generation);
            assert_eq!(source.activation_epoch(), installed.activation_epoch);
            assert_eq!(source.component_length(), component.len() as u64);
            assert!(source.component_offset() > 0);
            assert_eq!(source.component_sha256(), &Sha256Digest::of(component));
            assert_eq!(source.runtime_profile(), installed.manifest.runtime_profile);
            assert_eq!(
                source.import_export_fingerprint().as_str(),
                inspection.import_export_fingerprint
            );
            assert_eq!(
                source.permission_hash(),
                &manifest_permission_hash(&installed.manifest).unwrap()
            );
            assert_eq!(source.grants(), expected_grants);
            assert_eq!(source.stream_position().unwrap(), 0);
            let mut read = Vec::new();
            source.read_to_end(&mut read).unwrap();
            assert_eq!(read, component);
            assert_eq!(&Sha256Digest::of(&read), source.component_sha256());
        }
        let revision_after: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);
    }

    #[tokio::test]
    async fn repository_opens_component_sources_in_one_worker_command() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_266, 0);
        let (dependent, dependency) = active_dependency_graph(&mut connection, &store, now);
        drop(connection);
        drop(store);

        let owner = crate::ProfileOwner::open(&profile.path).unwrap();
        let repository = owner.repository();
        let current = repository.get_installed_plugin_profile().await.unwrap();
        let mut selected: Vec<_> = current.plugins.iter().map(component_selection).collect();
        selected.sort_by(|left, right| left.plugin_id.cmp(&right.plugin_id));
        let mut sources = repository
            .open_plugin_component_sources(selected)
            .await
            .unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources.remove(0).plugin_id(), &dependency.plugin_id);
        assert_eq!(sources.remove(0).plugin_id(), &dependent.plugin_id);
    }

    #[test]
    fn component_source_selection_rejects_shape_staleness_and_incomplete_authority() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_261, 0);
        let (dependent, dependency) = active_dependency_graph(&mut connection, &store, now);
        let selected = vec![
            component_selection(&dependent),
            component_selection(&dependency),
        ];

        assert!(open_plugin_component_sources(&mut connection, &store, Vec::new()).is_err());
        let mut seventeen = Vec::new();
        for index in 0..=PLUGINS_ENABLED_MAX {
            seventeen.push(PluginComponentSelection {
                plugin_id: PluginId::parse(format!("entry-{index:02}")).unwrap(),
                package_generation: 1,
                activation_epoch: 1,
            });
        }
        assert!(matches!(
            open_plugin_component_sources(&mut connection, &store, seventeen),
            Err(RepositoryError::OperationTooLarge)
        ));
        assert!(
            open_plugin_component_sources(
                &mut connection,
                &store,
                vec![selected[1].clone(), selected[0].clone()],
            )
            .is_err()
        );
        assert!(
            open_plugin_component_sources(
                &mut connection,
                &store,
                vec![selected[0].clone(), selected[0].clone()],
            )
            .is_err()
        );
        assert!(
            open_plugin_component_sources(
                &mut connection,
                &store,
                vec![PluginComponentSelection {
                    plugin_id: PluginId::parse("missing-plugin").unwrap(),
                    package_generation: 1,
                    activation_epoch: 1,
                }],
            )
            .is_err()
        );
        assert!(
            open_plugin_component_sources(&mut connection, &store, vec![selected[0].clone()],)
                .is_err()
        );

        let mut stale = selected.clone();
        stale[0].package_generation += 1;
        assert!(open_plugin_component_sources(&mut connection, &store, stale).is_err());
        let mut stale = selected.clone();
        stale[0].activation_epoch += 1;
        assert!(open_plugin_component_sources(&mut connection, &store, stale).is_err());

        connection
            .execute(
                "UPDATE plugins SET desired_enabled = 0, runtime_state = 'disabled',
                    failure_count = 0, last_error_code = NULL, next_retry_at = NULL
                 WHERE plugin_id = ?1",
                [dependent.plugin_id.as_str()],
            )
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        connection
            .execute(
                "UPDATE plugins SET desired_enabled = 1, runtime_state = 'active'
                 WHERE plugin_id = ?1",
                [dependent.plugin_id.as_str()],
            )
            .unwrap();

        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'degraded', failure_count = 1,
                    last_error_code = 'timeout', next_retry_at = ?2
                 WHERE plugin_id = ?1",
                params![dependent.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'active', failure_count = 0,
                    last_error_code = NULL, next_retry_at = NULL
                 WHERE plugin_id = ?1",
                [dependent.plugin_id.as_str()],
            )
            .unwrap();

        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'degraded', failure_count = 1,
                    last_error_code = 'timeout', next_retry_at = ?2
                 WHERE plugin_id = ?1",
                params![dependency.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'active', failure_count = 0,
                    last_error_code = NULL, next_retry_at = NULL
                 WHERE plugin_id = ?1",
                [dependency.plugin_id.as_str()],
            )
            .unwrap();

        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_dependency_locks
                 SET dependency_package_generation = dependency_package_generation + 1
                 WHERE plugin_id = ?1",
                [dependent.plugin_id.as_str()],
            )
            .unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected).is_err());
    }

    #[test]
    fn component_source_rejects_grant_and_permission_hash_mismatch_without_repair() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_262, 0);
        let (_, dependency) = active_dependency_graph(&mut connection, &store, now);
        let selected = vec![component_selection(&dependency)];
        let permission_hash = manifest_permission_hash(&dependency.manifest).unwrap();

        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_grants SET permission_hash = ?2 WHERE plugin_id = ?1",
                params![dependency.plugin_id.as_str(), "00".repeat(32)],
            )
            .unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        let retained: String = connection
            .query_row(
                "SELECT permission_hash FROM plugin_grants WHERE plugin_id = ?1 LIMIT 1",
                [dependency.plugin_id.as_str()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, "00".repeat(32));
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_grants SET permission_hash = ?2 WHERE plugin_id = ?1",
                params![dependency.plugin_id.as_str(), permission_hash.as_str()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE plugins SET permission_hash = ?2 WHERE plugin_id = ?1",
                params![dependency.plugin_id.as_str(), "11".repeat(32)],
            )
            .unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        connection
            .pragma_update(None, "foreign_keys", false)
            .unwrap();
        connection
            .execute(
                "UPDATE plugins SET permission_hash = ?2 WHERE plugin_id = ?1",
                params![dependency.plugin_id.as_str(), permission_hash.as_str()],
            )
            .unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        assert_eq!(
            open_plugin_component_sources(&mut connection, &store, selected)
                .unwrap()
                .len(),
            1
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
    }

    #[test]
    fn component_source_rejects_package_identity_publisher_and_component_corruption() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_263, 0);
        let (_, dependency) = active_dependency_graph(&mut connection, &store, now);
        let selected = vec![component_selection(&dependency)];
        let (bytes, authority, public_key) = package("zzz-dependency", "1.0.0");
        assert_eq!(authority.package_sha256(), &dependency.package_sha256);
        let path = store.package_path(&dependency.package_sha256);

        write_private_package(&path, b"corrupt");
        let error = match open_plugin_component_sources(&mut connection, &store, selected.clone()) {
            Err(error) => error,
            Ok(_) => panic!("corrupt package source was accepted"),
        };
        assert!(!error.to_string().contains(profile.path.to_str().unwrap()));
        write_private_package(&path, &bytes);

        let mut component_mismatch = bytes.clone();
        *component_mismatch.last_mut().unwrap() ^= 1;
        write_private_package(&path, &component_mismatch);
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        write_private_package(&path, &bytes);

        let manifest_len =
            usize::try_from(u32::from_be_bytes(bytes[8..12].try_into().unwrap())).unwrap();
        let mut publisher_mismatch = bytes.clone();
        publisher_mismatch[12 + manifest_len] ^= 1;
        write_private_package(&path, &publisher_mismatch);
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        write_private_package(&path, &bytes);

        let (other, _, _) = package("other-plugin", "1.0.0");
        write_private_package(&path, &other);
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        write_private_package(&path, &bytes);

        connection
            .execute(
                "UPDATE plugin_publisher_trust SET public_key = ?2 WHERE key_id = ?1",
                params![dependency.publisher_key_id.as_str(), vec![99_u8; 32]],
            )
            .unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        connection
            .execute(
                "UPDATE plugin_publisher_trust SET public_key = ?2 WHERE key_id = ?1",
                params![dependency.publisher_key_id.as_str(), public_key.to_vec()],
            )
            .unwrap();
        assert_eq!(
            open_plugin_component_sources(&mut connection, &store, selected)
                .unwrap()
                .len(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn component_source_rejects_unsafe_file_objects_and_permissions() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_264, 0);
        let (_, dependency) = active_dependency_graph(&mut connection, &store, now);
        let selected = vec![component_selection(&dependency)];
        let (bytes, _, _) = package("zzz-dependency", "1.0.0");
        let path = store.package_path(&dependency.package_sha256);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        fs::remove_dir(&path).unwrap();

        let oversized = File::create(&path).unwrap();
        oversized
            .set_len(junban_plugin_sdk::PACKAGE_BYTES_MAX as u64 + 1)
            .unwrap();
        drop(oversized);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        fs::remove_file(&path).unwrap();

        let target = profile.path.join("private-package-target");
        write_private_package(&target, &bytes);
        symlink(&target, &path).unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected.clone()).is_err());
        fs::remove_file(&path).unwrap();

        fs::hard_link(&target, &path).unwrap();
        assert!(open_plugin_component_sources(&mut connection, &store, selected).is_err());
    }

    #[test]
    fn opened_component_handle_survives_package_rename_replacement_and_unlink() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_265, 0);
        let (_, dependency) = active_dependency_graph(&mut connection, &store, now);
        let path = store.package_path(&dependency.package_sha256);
        let mut source = open_plugin_component_sources(
            &mut connection,
            &store,
            vec![component_selection(&dependency)],
        )
        .unwrap()
        .pop()
        .unwrap();
        let detached = path.with_extension("opened");
        fs::rename(&path, &detached).unwrap();
        let (replacement, _, _) = package("replacement-plugin", "1.0.0");
        write_private_package(&path, &replacement);
        fs::remove_file(detached).unwrap();

        let expected = include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");
        let mut component = Vec::new();
        source.read_to_end(&mut component).unwrap();
        assert_eq!(component, expected);
        assert_eq!(component.len() as u64, source.component_length());
        assert_eq!(&Sha256Digest::of(&component), source.component_sha256());
    }

    #[test]
    fn surface_invocation_entry_binds_the_surface_not_a_nonunique_action() {
        let (_, authority, _) = package("surface-plugin", "1.0.0");
        let mut manifest = authority.manifest().clone();
        manifest.surfaces = vec![
            SurfaceDeclaration {
                id: "dashboard".to_owned(),
                kind: SurfaceKind::View,
                title: "Dashboard".to_owned(),
                icon: None,
                location: SurfaceLocation::Navigation,
                actions: vec!["refresh".to_owned()],
            },
            SurfaceDeclaration {
                id: "sidebar".to_owned(),
                kind: SurfaceKind::Panel,
                title: "Sidebar".to_owned(),
                icon: None,
                location: SurfaceLocation::Sidebar,
                actions: vec!["refresh".to_owned()],
            },
        ];

        let dashboard = PluginManifestEntry::SurfaceAction {
            surface_id: PluginId::parse("dashboard").unwrap(),
            action_id: PluginId::parse("refresh").unwrap(),
        };
        let sidebar = PluginManifestEntry::SurfaceAction {
            surface_id: PluginId::parse("sidebar").unwrap(),
            action_id: PluginId::parse("refresh").unwrap(),
        };
        let dashboard = plugin_manifest_entry_authority(
            &manifest,
            PluginHookKind::HandleSurfaceAction,
            PluginManifestEntrySelector::Requested(&dashboard),
        )
        .unwrap();
        let sidebar = plugin_manifest_entry_authority(
            &manifest,
            PluginHookKind::HandleSurfaceAction,
            PluginManifestEntrySelector::Requested(&sidebar),
        )
        .unwrap();
        assert_eq!(dashboard.required_capability, Some(Capability::UiView));
        assert_eq!(sidebar.required_capability, Some(Capability::UiPanel));
        assert_ne!(dashboard.persisted_id, sidebar.persisted_id);
    }

    #[test]
    fn surface_pair_authority_survives_persistence_and_reopen() {
        let surfaces = vec![
            SurfaceDeclaration {
                id: "dashboard".to_owned(),
                kind: SurfaceKind::View,
                title: "Dashboard".to_owned(),
                icon: None,
                location: SurfaceLocation::Navigation,
                actions: vec!["refresh".to_owned()],
            },
            SurfaceDeclaration {
                id: "sidebar".to_owned(),
                kind: SurfaceKind::Panel,
                title: "Sidebar".to_owned(),
                icon: None,
                location: SurfaceLocation::Sidebar,
                actions: vec!["refresh".to_owned()],
            },
        ];
        let (bytes, authority, public_key) = package_with_surfaces(
            "surface-plugin",
            "1.0.0",
            Vec::new(),
            &KEY_BYTES,
            vec![EventKind::TaskCreated],
            surfaces,
        );
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_001, 0);
        publish_bytes(&store, &bytes).unwrap();
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        assert!(matches!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    package: authority,
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing: false,
                    allow_downgrade: false,
                },
                now,
            )
            .unwrap(),
            PluginMutationOutcome::Committed(_)
        ));
        let installed =
            get_installed_plugin(&connection, PluginId::parse("surface-plugin").unwrap()).unwrap();
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::UiPanel, Capability::UiView],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let dashboard_entry = PluginManifestEntry::SurfaceAction {
            surface_id: PluginId::parse("dashboard").unwrap(),
            action_id: PluginId::parse("refresh").unwrap(),
        };
        let dashboard_operation = OperationId::new();
        let request = ReservePluginInvocationRequest {
            operation_id: dashboard_operation,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::HandleSurfaceAction,
            entry: dashboard_entry.clone(),
            request_sha256: Sha256Digest::of(b"dashboard-refresh"),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        reserve_invocation_for_test(&mut connection, request, now).unwrap();
        let dashboard_persisted: String = connection
            .query_row(
                "SELECT entry_id FROM plugin_invocations WHERE operation_id = ?1",
                [dashboard_operation.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            dashboard_persisted,
            "219e3b484ebb41ff219f1747e05fab560d81655e92e10bfa985171883c4421a4"
        );
        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        assert!(backup.path().is_file());
        drop(backup);
        drop(connection);

        let mut connection = profile.connection();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        assert_eq!(
            load_invocation(&connection, dashboard_operation)
                .unwrap()
                .entry,
            dashboard_entry
        );
        terminalize_invocation_for_test(
            &mut connection,
            dashboard_operation,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            now,
        )
        .unwrap();
        let sidebar_operation = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id: sidebar_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::HandleSurfaceAction,
                entry: PluginManifestEntry::SurfaceAction {
                    surface_id: PluginId::parse("sidebar").unwrap(),
                    action_id: PluginId::parse("refresh").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"sidebar-refresh"),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            },
            now,
        )
        .unwrap();
        let sidebar_persisted: String = connection
            .query_row(
                "SELECT entry_id FROM plugin_invocations WHERE operation_id = ?1",
                [sidebar_operation.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            sidebar_persisted,
            "cf9341a91359732fb9146d2cd6426495c7eecb3e344be53fbfa3301e82457e33"
        );
        assert_ne!(dashboard_persisted, sidebar_persisted);
        terminalize_invocation_for_test(
            &mut connection,
            sidebar_operation,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            now,
        )
        .unwrap();
        assert_eq!(
            reserve_invocation_for_test(
                &mut connection,
                ReservePluginInvocationRequest {
                    operation_id: OperationId::new(),
                    plugin_id: plugin.plugin_id,
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    hook_kind: PluginHookKind::HandleSurfaceAction,
                    entry: PluginManifestEntry::SurfaceAction {
                        surface_id: PluginId::parse("dashboard").unwrap(),
                        action_id: PluginId::parse("missing").unwrap(),
                    },
                    request_sha256: Sha256Digest::of(b"forged-pair"),
                    delivery_operation_id: OperationId::new(),
                    resync_session: None,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
    }

    #[test]
    fn event_invocations_require_the_exact_granted_subscription_scope() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_000, 0);
        let (bytes, authority, public_key) = package_with_key_and_events(
            "event-plugin",
            "1.0.0",
            Vec::new(),
            &KEY_BYTES,
            vec![EventKind::TaskCreated, EventKind::TaskDeleted],
        );
        publish_bytes(&store, &bytes).unwrap();
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        let PluginMutationOutcome::Committed(_) = install_plugin(
            &mut connection,
            &store,
            OperationId::new(),
            InstallPluginRequest {
                package: authority,
                source: PluginInstallSource::CommunityRegistry,
                replace_existing: false,
                allow_downgrade: false,
            },
            now,
        )
        .unwrap() else {
            panic!("event fixture installation was unexpectedly blocked");
        };
        let installed =
            get_installed_plugin(&connection, PluginId::parse("event-plugin").unwrap()).unwrap();
        let active_without_grant = activate_plugin(&mut connection, &store, &installed, now);
        let reservation = |plugin: &InstalledPlugin, entry: &str| ReservePluginInvocationRequest {
            operation_id: OperationId::new(),
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::HandleEvent,
            entry: PluginManifestEntry::Event {
                event_id: PluginId::parse(entry).unwrap(),
            },
            request_sha256: Sha256Digest::of(entry.as_bytes()),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        assert_eq!(
            reserve_invocation_for_test(
                &mut connection,
                reservation(&active_without_grant, "task-deleted"),
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );

        let event_grant = installed
            .manifest
            .permissions
            .iter()
            .find(|permission| permission.capability == Capability::EventsSubscribe)
            .unwrap()
            .clone();
        replace_plugin_grants(
            &mut connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                installed.plugin_id.clone(),
                installed.package_generation,
                &installed.manifest.permissions,
                vec![event_grant],
            )
            .unwrap(),
            now,
        )
        .unwrap();
        let granted = get_installed_plugin(&connection, installed.plugin_id.clone()).unwrap();
        let active = activate_plugin(&mut connection, &store, &granted, now);
        let granted_reservation = |entry: &str| ReservePluginInvocationRequest {
            operation_id: OperationId::new(),
            plugin_id: active.plugin_id.clone(),
            package_generation: active.package_generation,
            activation_epoch: active.activation_epoch,
            hook_kind: PluginHookKind::HandleEvent,
            entry: PluginManifestEntry::Event {
                event_id: PluginId::parse(entry).unwrap(),
            },
            request_sha256: Sha256Digest::of(entry.as_bytes()),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };

        let reserved =
            reserve_invocation_for_test(&mut connection, granted_reservation("task-deleted"), now)
                .unwrap();
        let invocation = reserved.invocation().unwrap().clone();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: invocation.operation_id,
                plugin_id: invocation.plugin_id.clone(),
                package_generation: invocation.package_generation,
                activation_epoch: invocation.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();
        let cursor = get_plugin_cursor(&connection, invocation.plugin_id.clone()).unwrap();
        commit_invocation_for_test(
            &mut connection,
            plan(CommitPluginInvocationRequest {
                invocation_operation_id: invocation.operation_id,
                plugin_id: invocation.plugin_id.clone(),
                package_generation: invocation.package_generation,
                activation_epoch: invocation.activation_epoch,
                child_operation_id: None,
                domain_effect: None,
                kv_patch: None,
                resync_kv: None,
                cursor: Some(AdvancePluginCursorRequest {
                    plugin_id: invocation.plugin_id,
                    package_generation: invocation.package_generation,
                    activation_epoch: invocation.activation_epoch,
                    expected: PluginCursorPosition::from(&cursor),
                    next: PluginCursorPosition::from(&cursor),
                }),
                resync_session: None,
            }),
            now,
        )
        .unwrap();
    }

    #[test]
    fn install_grants_settings_and_kv_use_normalized_authority() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_000, 0);
        let plugin = install_fixture(&mut connection, &store, now);
        assert_eq!(plugin.package_generation, 1);
        assert_eq!(plugin.activation_epoch, 0);
        assert_eq!(plugin.runtime_state, PluginRuntimeState::Disabled);

        let grants = vec![
            plugin
                .manifest
                .permissions
                .iter()
                .find(|permission| permission.capability == Capability::Storage)
                .unwrap()
                .clone(),
        ];
        replace_plugin_grants(
            &mut connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                plugin.plugin_id.clone(),
                plugin.package_generation,
                &plugin.manifest.permissions,
                grants,
            )
            .unwrap(),
            now,
        )
        .unwrap();
        assert_eq!(
            list_plugin_grants(&connection, plugin.plugin_id.clone())
                .unwrap()
                .len(),
            1
        );

        let stale_setting = SetPluginSettingRequest {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation + 1,
            key: PluginId::parse("enabled").unwrap(),
            value: SettingValue::Boolean(true),
        };
        assert_eq!(
            set_plugin_setting(&mut connection, OperationId::new(), stale_setting, now,)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        set_plugin_setting(
            &mut connection,
            OperationId::new(),
            SetPluginSettingRequest {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                key: PluginId::parse("enabled").unwrap(),
                value: SettingValue::Boolean(true),
            },
            now,
        )
        .unwrap();
        assert_eq!(
            list_plugin_settings(&connection, plugin.plugin_id.clone())
                .unwrap()
                .len(),
            1
        );

        let current = get_installed_plugin(&connection, plugin.plugin_id.clone()).unwrap();
        let active = activate_plugin(&mut connection, &store, &current, now);
        assert_eq!(
            reserve_invocation_for_test(
                &mut connection,
                ReservePluginInvocationRequest {
                    operation_id: OperationId::new(),
                    plugin_id: active.plugin_id.clone(),
                    package_generation: active.package_generation,
                    activation_epoch: active.activation_epoch,
                    hook_kind: PluginHookKind::InvokeCommand,
                    entry: PluginManifestEntry::Command {
                        command_id: PluginId::parse("run").unwrap()
                    },
                    request_sha256: Sha256Digest::of(b"missing-command-grant"),
                    delivery_operation_id: OperationId::new(),
                    resync_session: None,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let entries = patch_plugin_kv(
            &mut connection,
            plugin.plugin_id.clone(),
            active.package_generation,
            active.activation_epoch,
            PluginKvPatch {
                set: vec![("namespaced/key".to_owned(), b"value".to_vec())],
                delete: Vec::new(),
            },
            now,
        )
        .unwrap();
        assert_eq!(entries[0].key, "namespaced/key");
        assert_eq!(entries[0].value, b"value");

        let public_key = SigningKey::from_bytes(&KEY_BYTES)
            .verifying_key()
            .to_bytes();
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        let after_retrust = get_installed_plugin(&connection, active.plugin_id.clone()).unwrap();
        assert_eq!(after_retrust.activation_epoch, active.activation_epoch);
        assert_eq!(after_retrust.runtime_state, PluginRuntimeState::Active);
        assert!(after_retrust.desired_enabled);

        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        let revision: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 8);
    }

    #[test]
    fn local_package_requires_explicit_trust_and_community_policy() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_025, 0);
        let (local_bytes, local, public_key) = package("local-plugin", "1.0.0");
        assert_eq!(local.publisher_public_key(), &public_key);
        publish_bytes(&store, &local_bytes).unwrap();
        let local_request = InstallPluginRequest {
            package: local,
            source: PluginInstallSource::LocalPackage,
            replace_existing: false,
            allow_downgrade: false,
        };
        assert_eq!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                local_request.clone(),
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        assert_eq!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                local_request.clone(),
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        assert!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                local_request,
                now,
            )
            .unwrap()
            .committed()
            .is_some()
        );

        let (community_bytes, community, _) = package("community-plugin", "1.0.0");
        publish_bytes(&store, &community_bytes).unwrap();
        assert!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    package: community,
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing: false,
                    allow_downgrade: false,
                },
                now,
            )
            .unwrap()
            .committed()
            .is_some()
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn settings_and_kv_aggregate_failures_roll_back_without_partial_rows() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_050, 0);
        let plugin = install_fixture(&mut connection, &store, now);
        for index in 0..7 {
            set_plugin_setting(
                &mut connection,
                OperationId::new(),
                SetPluginSettingRequest {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    key: PluginId::parse(format!("large-{index}")).unwrap(),
                    value: SettingValue::Text("x".repeat(8_192)),
                },
                now,
            )
            .unwrap();
        }
        let revision_before_failure: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            set_plugin_setting(
                &mut connection,
                OperationId::new(),
                SetPluginSettingRequest {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    key: PluginId::parse("large-7").unwrap(),
                    value: SettingValue::Text("x".repeat(8_192)),
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::OperationTooLarge
        );
        assert_eq!(
            list_plugin_settings(&connection, plugin.plugin_id.clone())
                .unwrap()
                .len(),
            7
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before_failure
        );

        let current = get_installed_plugin(&connection, plugin.plugin_id.clone()).unwrap();
        let storage_grant = current
            .manifest
            .permissions
            .iter()
            .find(|permission| permission.capability == Capability::Storage)
            .unwrap()
            .clone();
        replace_plugin_grants(
            &mut connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                current.plugin_id.clone(),
                current.package_generation,
                &current.manifest.permissions,
                vec![storage_grant],
            )
            .unwrap(),
            now,
        )
        .unwrap();
        let current = get_installed_plugin(&connection, current.plugin_id).unwrap();
        let current = activate_plugin(&mut connection, &store, &current, now);
        let patch = PluginKvPatch {
            set: (0..33)
                .map(|index| (format!("key/{index:02}"), vec![index as u8; 65_536]))
                .collect(),
            delete: Vec::new(),
        };
        assert_eq!(
            patch_plugin_kv(
                &mut connection,
                current.plugin_id.clone(),
                current.package_generation,
                current.activation_epoch,
                patch,
                now,
            )
            .unwrap_err(),
            RepositoryError::OperationTooLarge
        );
        assert!(
            list_plugin_kv(&connection, current.plugin_id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn operator_receipts_replay_exactly_and_reject_changed_requests() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_100, 0);
        let (bytes, authority, public_key) = package("receipt-plugin", "1.0.0");
        publish_bytes(&store, &bytes).unwrap();
        let trust_operation_id = OperationId::new();
        let trust_request = TrustPublisherRequest::new(public_key);
        trust_publisher(
            &mut connection,
            trust_operation_id,
            trust_request.clone(),
            now,
        )
        .unwrap();
        assert!(
            !trust_publisher(
                &mut connection,
                trust_operation_id,
                trust_request.clone(),
                now,
            )
            .unwrap()
            .newly_committed
        );
        assert_eq!(
            trust_publisher(
                &mut connection,
                trust_operation_id,
                TrustPublisherRequest {
                    key_id: trust_request.key_id,
                    public_key: [31; 32],
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();

        let operation_id = OperationId::new();
        let request = InstallPluginRequest {
            package: authority,
            source: PluginInstallSource::CommunityRegistry,
            replace_existing: false,
            allow_downgrade: false,
        };
        let first =
            install_plugin(&mut connection, &store, operation_id, request.clone(), now).unwrap();
        // Receipt matching precedes mutable package-store revalidation, so an exact
        // response-lost retry remains exact even if startup must later quarantine bytes.
        fs::write(
            store.package_path(request.package.package_sha256()),
            b"corrupt",
        )
        .unwrap();
        let replay =
            install_plugin(&mut connection, &store, operation_id, request.clone(), now).unwrap();
        let first = first.committed().unwrap();
        let replay = replay.committed().unwrap();
        assert!(first.newly_committed);
        assert!(!replay.newly_committed);
        assert_eq!(first, replay);

        let changed = InstallPluginRequest {
            allow_downgrade: true,
            ..request
        };
        assert_eq!(
            install_plugin(&mut connection, &store, operation_id, changed, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        let (revision, next_generation): (i64, i64) = connection
            .query_row(
                "SELECT app.global_revision, plugins.next_package_generation
                 FROM app_state app CROSS JOIN plugin_profile_state plugins
                 WHERE app.singleton = 1 AND plugins.singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((revision, next_generation), (3, 2));
    }

    #[test]
    fn uninstall_reinstall_keeps_global_generation_monotonic_after_receipt_pruning() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_120, 0);
        let plugin = install_fixture(&mut connection, &store, now);
        let old_generation = plugin.package_generation;
        let old_grant = RevokePluginGrantsRequest {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: old_generation,
            permission_hash: manifest_permission_hash(&plugin.manifest).unwrap(),
        };
        let uninstalled = uninstall_plugin(
            &mut connection,
            &store,
            OperationId::new(),
            plugin.plugin_id.clone(),
            now,
        )
        .unwrap();
        let uninstalled = uninstalled.committed().unwrap();
        assert_eq!(
            uninstalled.event.primary.as_ref(),
            Some(&ResourceRef::plugin(&plugin.plugin_id))
        );
        assert!(uninstalled.event.snapshot.is_none());

        let (bytes, authority, _) = package("test-plugin", "1.0.0");
        publish_bytes(&store, &bytes).unwrap();
        let reinstalled = install_plugin(
            &mut connection,
            &store,
            OperationId::new(),
            InstallPluginRequest {
                package: authority,
                source: PluginInstallSource::CommunityRegistry,
                replace_existing: false,
                allow_downgrade: false,
            },
            now,
        )
        .unwrap();
        assert!(reinstalled.committed().is_some());
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM plugins", [], |row| row.get(0))
                .unwrap(),
            1
        );
        let current = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        assert!(current.package_generation > old_generation);

        let later = now.checked_add((31 * 24).hours()).unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, later).unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            revoke_plugin_grants(&mut connection, OperationId::new(), old_grant, later,)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );
    }

    #[test]
    fn replacement_rejects_incompatible_persisted_settings_without_allocation() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_121, 0);
        let plugin = install_fixture(&mut connection, &store, now);
        set_plugin_setting(
            &mut connection,
            OperationId::new(),
            SetPluginSettingRequest {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                key: PluginId::parse("enabled").unwrap(),
                value: SettingValue::Boolean(true),
            },
            now,
        )
        .unwrap();

        let (candidate_bytes, _, _) = package("test-plugin", "1.1.0");
        let verified = junban_plugin_sdk::verify_package(&candidate_bytes).unwrap();
        let mut manifest = verified.manifest.clone();
        manifest.settings.clear();
        let key = SigningKey::from_bytes(&KEY_BYTES);
        let candidate_bytes = pack_package(&manifest, verified.component_bytes, &key).unwrap();
        let candidate = PluginPackageAuthority::inspect(&candidate_bytes).unwrap();
        publish_bytes(&store, &candidate_bytes).unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    package: candidate,
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing: true,
                    allow_downgrade: false,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            get_installed_plugin(&connection, plugin.plugin_id.clone())
                .unwrap()
                .package_generation,
            plugin.package_generation
        );
        assert_eq!(
            list_plugin_settings(&connection, plugin.plugin_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT next_package_generation FROM plugin_profile_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            2
        );
    }

    #[test]
    fn concurrent_installs_allocate_distinct_global_generations() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_122, 0);
        let (left_bytes, left, public_key) = package("concurrent-left", "1.0.0");
        let (right_bytes, right, _) = package("concurrent-right", "1.0.0");
        publish_bytes(&store, &left_bytes).unwrap();
        publish_bytes(&store, &right_bytes).unwrap();
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        drop(connection);
        // Opening performs startup reconciliation, which is single-owner work. Open
        // sequentially, then race only the allocator transactions under test.
        let left_connection = crate::open_connection(&profile.path.join("junban.sqlite3")).unwrap();
        let right_connection =
            crate::open_connection(&profile.path.join("junban.sqlite3")).unwrap();

        let install = |mut connection: Connection,
                       store: PluginPackageStore,
                       package: PluginPackageAuthority| {
            std::thread::spawn(move || {
                let plugin_id = package.plugin_id().clone();
                install_plugin(
                    &mut connection,
                    &store,
                    OperationId::new(),
                    InstallPluginRequest {
                        package,
                        source: PluginInstallSource::CommunityRegistry,
                        replace_existing: false,
                        allow_downgrade: false,
                    },
                    now,
                )
                .unwrap();
                get_installed_plugin(&connection, plugin_id)
                    .unwrap()
                    .package_generation
            })
        };
        let left = install(left_connection, store.clone(), left);
        let right = install(right_connection, store, right);
        let mut generations = vec![left.join().unwrap(), right.join().unwrap()];
        generations.sort_unstable();
        assert_eq!(generations, vec![1, 2]);
        let connection = profile.connection();
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT next_package_generation FROM plugin_profile_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            3
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn enabled_plugin_ceiling_rejects_without_epoch_or_revision_change() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_124, 0);
        let (_, _, public_key) = package("signer-fixture", "1.0.0");
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        let mut plugin_ids = Vec::new();
        for index in 0..=PLUGINS_ENABLED_MAX {
            let plugin_id = format!("enabled-{index:02}");
            let (bytes, package, _) = package(&plugin_id, "1.0.0");
            publish_bytes(&store, &bytes).unwrap();
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    package,
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing: false,
                    allow_downgrade: false,
                },
                now,
            )
            .unwrap();
            plugin_ids.push(PluginId::parse(plugin_id).unwrap());
        }
        for plugin_id in plugin_ids.iter().take(PLUGINS_ENABLED_MAX) {
            set_plugin_desired_enabled(
                &mut connection,
                &store,
                OperationId::new(),
                plugin_id.clone(),
                true,
                now,
            )
            .unwrap();
        }
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let blocked = plugin_ids.last().unwrap().clone();
        let epoch_before = get_installed_plugin(&connection, blocked.clone())
            .unwrap()
            .activation_epoch;
        assert_eq!(
            set_plugin_desired_enabled(
                &mut connection,
                &store,
                OperationId::new(),
                blocked.clone(),
                true,
                now,
            )
            .unwrap_err(),
            RepositoryError::OperationTooLarge
        );
        assert_eq!(
            get_installed_plugin(&connection, blocked)
                .unwrap()
                .activation_epoch,
            epoch_before
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn replacement_requires_confirmation_and_rejects_signer_rotation() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_125, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let rotated_key = [29_u8; 32];
        let (bytes, replacement, public_key) =
            package_with_key("test-plugin", "1.1.0", Vec::new(), &rotated_key);
        publish_bytes(&store, &bytes).unwrap();
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let request = InstallPluginRequest {
            package: replacement.clone(),
            source: PluginInstallSource::CommunityRegistry,
            replace_existing: false,
            allow_downgrade: false,
        };
        assert_eq!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                request.clone(),
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );
        assert_eq!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    replace_existing: true,
                    ..request
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let unchanged = get_installed_plugin(&connection, installed.plugin_id.clone()).unwrap();
        assert_eq!(unchanged.package_generation, installed.package_generation);
        assert_eq!(unchanged.publisher_key_id, installed.publisher_key_id);
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );

        uninstall_plugin(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            now,
        )
        .unwrap();
        assert!(
            install_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    package: replacement,
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing: false,
                    allow_downgrade: false,
                },
                now,
            )
            .unwrap()
            .committed()
            .is_some()
        );
        let reinstalled = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        assert_eq!(reinstalled.package_generation, 2);
        assert_eq!(reinstalled.publisher_key_id, signer_key_id(&public_key));
    }

    #[test]
    fn dependency_replacement_rewrites_locks_and_blocks_incompatible_dependents() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_150, 0);
        let (base_bytes, base, public_key) = package("base-plugin", "1.0.0");
        let original_base_path = store.package_path(base.package_sha256());
        publish_bytes(&store, &base_bytes).unwrap();
        trust_publisher(
            &mut connection,
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        let install = |connection: &mut Connection,
                       authority: PluginPackageAuthority,
                       replace_existing: bool| {
            install_plugin(
                connection,
                &store,
                OperationId::new(),
                InstallPluginRequest {
                    package: authority,
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing,
                    allow_downgrade: false,
                },
                now,
            )
            .unwrap()
        };
        assert!(install(&mut connection, base, false).committed().is_some());

        let (child_bytes, child, _) = package_with_dependencies(
            "child-plugin",
            "1.0.0",
            vec![Dependency {
                id: "base-plugin".to_owned(),
                requirement: "^1.0".to_owned(),
                services: Vec::new(),
            }],
        );
        publish_bytes(&store, &child_bytes).unwrap();
        assert!(install(&mut connection, child, false).committed().is_some());
        for plugin_id in ["base-plugin", "child-plugin"] {
            assert!(
                set_plugin_desired_enabled(
                    &mut connection,
                    &store,
                    OperationId::new(),
                    PluginId::parse(plugin_id).unwrap(),
                    true,
                    now,
                )
                .unwrap()
                .committed()
                .is_some()
            );
        }
        match set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            PluginId::parse("base-plugin").unwrap(),
            false,
            now,
        )
        .unwrap()
        {
            PluginMutationOutcome::BlockedByDependents(ids) => {
                assert_eq!(ids, vec![PluginId::parse("child-plugin").unwrap()]);
            }
            other => panic!("unexpected disable outcome: {other:?}"),
        }
        let base_before_grant_revoke =
            get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap()).unwrap();
        let storage_grant = base_before_grant_revoke
            .manifest
            .permissions
            .iter()
            .find(|permission| permission.capability == Capability::Storage)
            .unwrap()
            .clone();
        replace_plugin_grants(
            &mut connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                base_before_grant_revoke.plugin_id.clone(),
                base_before_grant_revoke.package_generation,
                &base_before_grant_revoke.manifest.permissions,
                vec![storage_grant],
            )
            .unwrap(),
            now,
        )
        .unwrap();
        let base_before_revoke =
            get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap()).unwrap();
        revoke_plugin_grants(
            &mut connection,
            OperationId::new(),
            RevokePluginGrantsRequest {
                plugin_id: base_before_revoke.plugin_id.clone(),
                package_generation: base_before_revoke.package_generation,
                permission_hash: manifest_permission_hash(&base_before_revoke.manifest).unwrap(),
            },
            now,
        )
        .unwrap();
        assert!(
            !get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap())
                .unwrap()
                .desired_enabled
        );
        assert!(
            !get_installed_plugin(&connection, PluginId::parse("child-plugin").unwrap())
                .unwrap()
                .desired_enabled
        );
        for plugin_id in ["base-plugin", "child-plugin"] {
            set_plugin_desired_enabled(
                &mut connection,
                &store,
                OperationId::new(),
                PluginId::parse(plugin_id).unwrap(),
                true,
                now,
            )
            .unwrap();
        }
        let base_before_replacement =
            get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap()).unwrap();
        let storage_grant = base_before_replacement
            .manifest
            .permissions
            .iter()
            .find(|permission| permission.capability == Capability::Storage)
            .unwrap()
            .clone();
        replace_plugin_grants(
            &mut connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                base_before_replacement.plugin_id.clone(),
                base_before_replacement.package_generation,
                &base_before_replacement.manifest.permissions,
                vec![storage_grant],
            )
            .unwrap(),
            now,
        )
        .unwrap();
        let child_before =
            get_installed_plugin(&connection, PluginId::parse("child-plugin").unwrap()).unwrap();

        let (compatible_bytes, compatible, _) = package("base-plugin", "1.1.0");
        publish_bytes(&store, &compatible_bytes).unwrap();
        assert!(
            install(&mut connection, compatible, true)
                .committed()
                .is_some()
        );
        let base_after =
            get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap()).unwrap();
        let child_after =
            get_installed_plugin(&connection, PluginId::parse("child-plugin").unwrap()).unwrap();
        assert_eq!(base_after.package_generation, 3);
        assert!(!original_base_path.exists());
        assert_eq!(
            child_after.activation_epoch,
            child_before.activation_epoch + 1
        );
        assert!(child_after.desired_enabled);
        assert_eq!(child_after.runtime_state, PluginRuntimeState::Starting);
        assert!(!child_after.dependencies_satisfied);
        assert!(!base_after.desired_enabled);
        assert_eq!(base_after.runtime_state, PluginRuntimeState::Disabled);
        assert!(
            list_plugin_grants(&connection, base_after.plugin_id.clone())
                .unwrap()
                .is_empty()
        );
        let lock_generation: i64 = connection
            .query_row(
                "SELECT dependency_package_generation FROM plugin_dependency_locks
                 WHERE plugin_id = 'child-plugin' AND dependency_id = 'base-plugin'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lock_generation, 3);
        assert!(
            set_plugin_desired_enabled(
                &mut connection,
                &store,
                OperationId::new(),
                PluginId::parse("base-plugin").unwrap(),
                true,
                now,
            )
            .unwrap()
            .committed()
            .is_some()
        );

        let (missing_bytes, missing, _) = package_with_dependencies(
            "base-plugin",
            "1.2.0",
            vec![Dependency {
                id: "missing-plugin".to_owned(),
                requirement: "^1.0".to_owned(),
                services: Vec::new(),
            }],
        );
        publish_bytes(&store, &missing_bytes).unwrap();
        assert!(matches!(
            install(&mut connection, missing, true),
            PluginMutationOutcome::GraphRejected(
                PluginGraphRejection::UnresolvedDependencies { .. }
            )
        ));

        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let (incompatible_bytes, incompatible, _) = package("base-plugin", "2.0.0");
        publish_bytes(&store, &incompatible_bytes).unwrap();
        match install(&mut connection, incompatible, true) {
            PluginMutationOutcome::BlockedByDependents(ids) => {
                assert_eq!(ids, vec![PluginId::parse("child-plugin").unwrap()])
            }
            other => panic!("unexpected replacement outcome: {other:?}"),
        }
        match uninstall_plugin(
            &mut connection,
            &store,
            OperationId::new(),
            PluginId::parse("base-plugin").unwrap(),
            now,
        )
        .unwrap()
        {
            PluginMutationOutcome::BlockedByDependents(ids) => {
                assert_eq!(ids, vec![PluginId::parse("child-plugin").unwrap()])
            }
            other => panic!("unexpected uninstall outcome: {other:?}"),
        }
        let revision_after: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);

        let mut failed =
            get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap()).unwrap();
        failed = record_failure(
            &mut connection,
            &failed,
            PluginAttemptFailureCause::GuestTrap,
            now,
        )
        .unwrap();
        for _ in 0..2 {
            let failure_now = failed.next_retry_at.unwrap();
            failed = retry_due(&mut connection, &failed, failure_now).unwrap();
            failed = record_failure(
                &mut connection,
                &failed,
                PluginAttemptFailureCause::GuestTrap,
                failure_now,
            )
            .unwrap();
        }
        let suspended_dependent =
            get_installed_plugin(&connection, PluginId::parse("child-plugin").unwrap()).unwrap();
        assert!(!suspended_dependent.desired_enabled);
        assert_eq!(
            suspended_dependent.runtime_state,
            PluginRuntimeState::Suspended
        );
        assert_eq!(
            suspended_dependent.last_error_code.as_deref(),
            Some("dependency_failed")
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_after + 5
        );

        connection
            .execute(
                "UPDATE plugins SET desired_enabled = 1, runtime_state = 'active',
                    failure_count = 0, last_error_code = NULL
                 WHERE plugin_id = 'child-plugin'",
                [],
            )
            .unwrap();
        assert!(crate::plugin_validation::validate_plugin_authority(&connection).is_err());
        assert!(get_installed_plugin_profile(&connection).is_err());
        connection
            .execute(
                "UPDATE plugins SET desired_enabled = 0, runtime_state = 'suspended',
                    failure_count = 3, last_error_code = 'dependency_failed'
                 WHERE plugin_id = 'child-plugin'",
                [],
            )
            .unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let hostile_digest = "ff".repeat(32);
        connection
            .execute_batch("PRAGMA foreign_keys = OFF")
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_dependency_locks SET dependency_package_sha256 = ?1
                 WHERE plugin_id = 'child-plugin' AND dependency_id = 'base-plugin'",
                [hostile_digest.as_str()],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
        assert!(
            uninstall_plugin(
                &mut connection,
                &store,
                OperationId::new(),
                PluginId::parse("child-plugin").unwrap(),
                now,
            )
            .is_err()
        );
        assert_eq!(
            connection
                .query_row::<String, _, _>(
                    "SELECT dependency_package_sha256 FROM plugin_dependency_locks
                     WHERE plugin_id = 'child-plugin' AND dependency_id = 'base-plugin'",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            hostile_digest
        );
        connection
            .execute(
                "UPDATE plugin_dependency_locks SET dependency_package_sha256 = ?1
                 WHERE plugin_id = 'child-plugin' AND dependency_id = 'base-plugin'",
                [base_after.package_sha256.as_str()],
            )
            .unwrap();

        fs::write(store.package_path(&base_after.package_sha256), b"corrupt").unwrap();
        let reconciliation = reconcile_packages(&mut connection, &store, now).unwrap();
        assert_eq!(
            reconciliation.disabled,
            vec![
                PluginId::parse("base-plugin").unwrap(),
                PluginId::parse("child-plugin").unwrap(),
            ]
        );
        let invalid_base =
            get_installed_plugin(&connection, PluginId::parse("base-plugin").unwrap()).unwrap();
        let suspended_child =
            get_installed_plugin(&connection, PluginId::parse("child-plugin").unwrap()).unwrap();
        assert_eq!(
            invalid_base.runtime_state,
            PluginRuntimeState::ReverifyRequired
        );
        assert_eq!(
            invalid_base.last_error_code.as_deref(),
            Some("package_invalid")
        );
        assert_eq!(suspended_child.runtime_state, PluginRuntimeState::Suspended);
        assert_eq!(
            suspended_child.last_error_code.as_deref(),
            Some("dependency_failed")
        );
        assert!(!suspended_child.desired_enabled);
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 5
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn invocation_effect_receipt_cursor_and_cleanup_are_one_transaction() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_175, 0);
        let plugin = install_fixture(&mut connection, &store, now);
        let grants: Vec<_> = plugin
            .manifest
            .permissions
            .iter()
            .filter(|permission| {
                matches!(
                    permission.capability,
                    Capability::EventsSubscribe | Capability::Storage | Capability::TasksWrite
                )
            })
            .cloned()
            .collect();
        replace_plugin_grants(
            &mut connection,
            OperationId::new(),
            ReplacePluginGrantsRequest::new(
                plugin.plugin_id.clone(),
                plugin.package_generation,
                &plugin.manifest.permissions,
                grants,
            )
            .unwrap(),
            now,
        )
        .unwrap();
        let granted = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        let invocation_operation_id = OperationId::new();
        let reservation = ReservePluginInvocationRequest {
            operation_id: invocation_operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::HandleEvent,
            entry: PluginManifestEntry::Event {
                event_id: PluginId::parse("task-created").unwrap(),
            },
            request_sha256: Sha256Digest::of(b"request"),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        assert!(
            !reserve_invocation_for_test(&mut connection, reservation.clone(), now)
                .unwrap()
                .replayed()
        );
        assert!(
            reserve_invocation_for_test(&mut connection, reservation.clone(), now)
                .unwrap()
                .replayed()
        );
        let mut changed_reservation = reservation;
        changed_reservation.request_sha256 = Sha256Digest::of(b"changed");
        assert_eq!(
            reserve_invocation_for_test(&mut connection, changed_reservation, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: invocation_operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();

        let task_id = TaskId::new();
        let child_operation_id = OperationId::new();
        let request = CommitPluginInvocationRequest {
            invocation_operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            child_operation_id: Some(child_operation_id),
            domain_effect: Some(PluginDomainEffect::CreateTask {
                task_id,
                draft: TaskDraft::new(TaskTitle::new("Plugin task").unwrap()),
            }),
            kv_patch: None,
            resync_kv: None,
            cursor: Some(AdvancePluginCursorRequest {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected: PluginCursorPosition::from(&cursor),
                next: PluginCursorPosition {
                    event_epoch: cursor.event_epoch.clone(),
                    revision: cursor.revision + 1,
                    resync_required: false,
                },
            }),
            resync_session: None,
        };
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let mut combined_effect = request.clone();
        combined_effect.kv_patch = Some(PluginKvPatch {
            set: vec![("result/id".to_owned(), task_id.to_string().into_bytes())],
            delete: Vec::new(),
        });
        assert!(matches!(
            plan_result(combined_effect),
            Err(RepositoryError::Conflict)
        ));
        assert!(
            commit_plugin_invocation_with(&mut connection, plan(request.clone()), now, || Err(
                RepositoryError::Storage("injected terminal failure".to_owned())
            ),)
            .is_err()
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );
        assert_eq!(
            task_ops::get_task(&connection, task_id).unwrap_err(),
            RepositoryError::NotFound
        );
        assert_eq!(
            load_invocation(&connection, invocation_operation_id)
                .unwrap()
                .state,
            PluginInvocationState::EffectCommitting
        );

        let committed = commit_invocation_for_test(&mut connection, plan(request), now).unwrap();
        assert_eq!(
            committed.mutation.unwrap().event.revision,
            revision_before as u64 + 1
        );
        assert_eq!(committed.cursor.unwrap().revision, cursor.revision + 1);
        assert_eq!(
            task_ops::get_task(&connection, task_id)
                .unwrap()
                .title
                .as_str(),
            "Plugin task"
        );
        assert_eq!(
            load_invocation(&connection, invocation_operation_id).unwrap_err(),
            RepositoryError::NotFound
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn operator_terminal_receipts_survive_reopen_match_hash_expire_and_roll_back() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_183, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let operation_id = OperationId::new();
        let request = ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(b"terminal-read-only"),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        reserve_invocation_for_test(&mut connection, request.clone(), now).unwrap();
        assert!(
            terminalize_plugin_invocation_with(
                &mut connection,
                operation_id,
                plugin.plugin_id.clone(),
                plugin.package_generation,
                plugin.activation_epoch,
                now,
                || Err(RepositoryError::Storage(
                    "injected receipt rollback".to_owned()
                )),
            )
            .is_err()
        );
        assert_eq!(
            load_invocation(&connection, operation_id).unwrap().state,
            PluginInvocationState::Reserved
        );
        let receipt_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(receipt_count, 0);
        let committed = terminalize_invocation_for_test(
            &mut connection,
            operation_id,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            now,
        )
        .unwrap();
        assert_eq!(
            committed.terminal_kind,
            PluginInvocationTerminalKind::ReadOnly
        );
        let committed_json = serde_json::to_string(&committed).unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        drop(backup);
        drop(connection);

        let mut connection = profile.connection();
        let replay = reserve_invocation_for_test(&mut connection, request.clone(), now).unwrap();
        let terminal = replay.terminal().unwrap();
        assert!(terminal.replayed);
        assert_eq!(serde_json::to_string(terminal).unwrap(), committed_json);
        let mut changed = request.clone();
        changed.request_sha256 = Sha256Digest::of(b"changed-terminal-request");
        assert_eq!(
            reserve_invocation_for_test(&mut connection, changed, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );

        let expired = now
            .checked_add((PLUGIN_INVOCATION_RETENTION_DAYS * 24).hours())
            .unwrap();
        let fresh = reserve_invocation_for_test(&mut connection, request, expired).unwrap();
        assert!(matches!(fresh, ReservedPluginInvocation::Reserved(_)));
    }

    #[test]
    fn operator_domain_and_kv_terminal_receipts_replay_typed_results() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_184, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[
                Capability::Commands,
                Capability::Http,
                Capability::TasksWrite,
                Capability::Storage,
            ],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let reservation = |operation_id, hash: &'static [u8]| ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(hash),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };

        let domain_operation = OperationId::new();
        let domain_reservation = reservation(domain_operation, b"domain-terminal");
        reserve_invocation_for_test(&mut connection, domain_reservation.clone(), now).unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: domain_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();
        let task_id = TaskId::new();
        let domain = commit_invocation_for_test(
            &mut connection,
            plan(CommitPluginInvocationRequest {
                invocation_operation_id: domain_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                child_operation_id: Some(OperationId::new()),
                domain_effect: Some(PluginDomainEffect::CreateTask {
                    task_id,
                    draft: TaskDraft::new(TaskTitle::new("Typed terminal").unwrap()),
                }),
                kv_patch: None,
                resync_kv: None,
                cursor: None,
                resync_session: None,
            }),
            now,
        )
        .unwrap();
        assert_eq!(
            domain.terminal_kind,
            PluginInvocationTerminalKind::DomainEffect
        );
        assert!(domain.mutation.as_ref().unwrap().newly_committed);
        let replay = reserve_invocation_for_test(&mut connection, domain_reservation, now).unwrap();
        let replay = replay.terminal().unwrap();
        assert_eq!(
            replay.terminal_kind,
            PluginInvocationTerminalKind::DomainEffect
        );
        assert!(!replay.mutation.as_ref().unwrap().newly_committed);
        assert_eq!(replay.mutation, domain.mutation);

        let kv_operation = OperationId::new();
        let kv_reservation = reservation(kv_operation, b"kv-terminal");
        reserve_invocation_for_test(&mut connection, kv_reservation.clone(), now).unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: kv_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();
        let kv = commit_invocation_for_test(
            &mut connection,
            plan(CommitPluginInvocationRequest {
                invocation_operation_id: kv_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                child_operation_id: None,
                domain_effect: None,
                kv_patch: Some(PluginKvPatch {
                    set: vec![("result/value".to_owned(), vec![1, 2, 3])],
                    delete: Vec::new(),
                }),
                resync_kv: None,
                cursor: None,
                resync_session: None,
            }),
            now,
        )
        .unwrap();
        assert_eq!(kv.terminal_kind, PluginInvocationTerminalKind::Kv);
        assert!(kv.mutation.is_none());
        let mut expected_kv_replay = kv.clone();
        expected_kv_replay.replayed = true;
        assert_eq!(
            reserve_invocation_for_test(&mut connection, kv_reservation.clone(), now)
                .unwrap()
                .terminal()
                .unwrap(),
            &expected_kv_replay
        );
        let mut changed_kv = kv_reservation.clone();
        changed_kv.request_sha256 = Sha256Digest::of(b"changed-kv-terminal");
        assert_eq!(
            reserve_invocation_for_test(&mut connection, changed_kv, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );

        let http_operation = OperationId::new();
        let http_reservation = reservation(http_operation, b"http-terminal");
        reserve_invocation_for_test(&mut connection, http_reservation.clone(), now).unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        let http = commit_invocation_for_test(
            &mut connection,
            plan(CommitPluginInvocationRequest {
                invocation_operation_id: http_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                child_operation_id: None,
                domain_effect: None,
                kv_patch: None,
                resync_kv: None,
                cursor: None,
                resync_session: None,
            }),
            now,
        )
        .unwrap();
        assert_eq!(http.terminal_kind, PluginInvocationTerminalKind::Http);
        let mut expected_http_replay = http.clone();
        expected_http_replay.replayed = true;
        assert_eq!(
            reserve_invocation_for_test(&mut connection, http_reservation.clone(), now)
                .unwrap()
                .terminal()
                .unwrap(),
            &expected_http_replay
        );
        let mut changed_http = http_reservation.clone();
        changed_http.request_sha256 = Sha256Digest::of(b"changed-http-terminal");
        assert_eq!(
            reserve_invocation_for_test(&mut connection, changed_http, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        drop(backup);

        let expired = now
            .checked_add((PLUGIN_INVOCATION_RETENTION_DAYS * 24).hours())
            .unwrap();
        assert!(
            reserve_invocation_for_test(&mut connection, http_reservation.clone(), expired)
                .unwrap()
                .invocation()
                .is_some()
        );
        terminalize_invocation_for_test(
            &mut connection,
            http_operation,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            expired,
        )
        .unwrap();
        assert!(
            reserve_invocation_for_test(&mut connection, kv_reservation, expired)
                .unwrap()
                .invocation()
                .is_some()
        );
    }

    #[test]
    fn guest_effect_rejection_receipts_accept_only_closed_domain_effect_shapes() {
        let valid_rejection = CommittedPluginInvocation {
            terminal_kind: PluginInvocationTerminalKind::DomainEffect,
            mutation: None,
            cursor: None,
            rejection: Some(PluginGuestEffectRejection::NotFound),
            replayed: false,
        };
        assert!(plugin_invocation_terminal_shape_is_valid(&valid_rejection));

        let valid_old_read_only = CommittedPluginInvocation {
            terminal_kind: PluginInvocationTerminalKind::ReadOnly,
            mutation: None,
            cursor: None,
            rejection: None,
            replayed: false,
        };
        assert!(plugin_invocation_terminal_shape_is_valid(
            &valid_old_read_only
        ));

        let mut invalid = valid_rejection.clone();
        invalid.terminal_kind = PluginInvocationTerminalKind::Kv;
        assert!(!plugin_invocation_terminal_shape_is_valid(&invalid));
        let mut invalid = valid_rejection.clone();
        invalid.mutation = Some(CommittedMutation {
            event: CommittedEvent {
                revision: 1,
                operation_id: OperationId::new(),
                event_type: EventType::new(EventType::TASK_DELETED),
                occurred_at: Timestamp::constant(1_800_000_000, 0),
                primary: Some(ResourceRef::task(TaskId::new())),
                snapshot: None,
                affected: AffectedIds::default(),
                resync: ResyncScope::TASKS,
            },
            uncomplete_outcome: None,
            newly_committed: true,
        });
        assert!(!plugin_invocation_terminal_shape_is_valid(&invalid));
        let mut invalid = valid_rejection;
        invalid.cursor = Some(PluginEventCursor {
            plugin_id: PluginId::parse("receipt-shape").unwrap(),
            event_epoch: OperationId::new().to_string(),
            revision: 1,
            resync_required: false,
            updated_at: Timestamp::constant(1_800_000_000, 0),
        });
        assert!(!plugin_invocation_terminal_shape_is_valid(&invalid));
    }

    #[test]
    fn exact_child_receipt_mismatch_terminalizes_without_advancing_the_cursor() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_184, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe, Capability::TasksWrite],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        let invocation_operation_id = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id: invocation_operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::HandleEvent,
                entry: PluginManifestEntry::Event {
                    event_id: PluginId::parse("task-created").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"receipt-replay-event"),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: invocation_operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();

        let task_id = TaskId::new();
        let child_operation_id = OperationId::new();
        let draft = TaskDraft::new(TaskTitle::new("Receipt-backed task").unwrap());
        let first = task_ops::create_task(
            &mut connection,
            child_operation_id,
            task_id,
            draft.clone(),
            now,
        )
        .unwrap();
        let revision_after_effect = first.event.revision;
        let request = CommitPluginInvocationRequest {
            invocation_operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            child_operation_id: Some(child_operation_id),
            domain_effect: Some(PluginDomainEffect::CreateTask { task_id, draft }),
            kv_patch: None,
            resync_kv: None,
            cursor: Some(AdvancePluginCursorRequest {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected: PluginCursorPosition::from(&cursor),
                next: PluginCursorPosition {
                    event_epoch: cursor.event_epoch.clone(),
                    revision: revision_after_effect,
                    resync_required: false,
                },
            }),
            resync_session: None,
        };
        let mut changed = request.clone();
        changed.domain_effect = Some(PluginDomainEffect::CreateTask {
            task_id,
            draft: TaskDraft::new(TaskTitle::new("Changed task").unwrap()),
        });
        let rejected = commit_invocation_for_test(&mut connection, plan(changed), now).unwrap();
        assert_eq!(
            rejected.rejection,
            Some(PluginGuestEffectRejection::IdempotencyMismatch)
        );
        assert!(rejected.mutation.is_none());
        assert!(rejected.cursor.is_none());
        assert!(!rejected.replayed);
        assert_eq!(
            get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap(),
            cursor
        );
        assert_eq!(
            load_invocation(&connection, invocation_operation_id).unwrap_err(),
            RepositoryError::NotFound
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap() as u64,
            revision_after_effect
        );
    }

    #[test]
    fn http_only_terminal_cursor_and_invocation_cleanup_are_atomic() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_185, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        let head: u64 = connection
            .query_row::<i64, _, _>(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap() as u64;
        let operation_id = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::HandleEvent,
                entry: PluginManifestEntry::Event {
                    event_id: PluginId::parse("task-created").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"event"),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        connection
            .execute(
                "UPDATE plugin_invocations SET error_code = 'timeout' WHERE operation_id = ?1",
                [operation_id.to_string()],
            )
            .unwrap();
        assert!(crate::plugin_validation::validate_plugin_authority(&connection).is_err());
        connection
            .execute(
                "UPDATE plugin_invocations SET error_code = NULL WHERE operation_id = ?1",
                [operation_id.to_string()],
            )
            .unwrap();
        let request = CommitPluginInvocationRequest {
            invocation_operation_id: operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            child_operation_id: None,
            domain_effect: None,
            kv_patch: None,
            resync_kv: None,
            cursor: Some(AdvancePluginCursorRequest {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected: PluginCursorPosition::from(&cursor),
                next: PluginCursorPosition {
                    event_epoch: cursor.event_epoch.clone(),
                    revision: head,
                    resync_required: false,
                },
            }),
            resync_session: None,
        };
        assert!(
            commit_plugin_invocation_with(&mut connection, plan(request.clone()), now, || Err(
                RepositoryError::Storage("injected HTTP terminal failure".to_owned())
            ),)
            .is_err()
        );
        assert_eq!(
            get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap(),
            cursor
        );
        assert_eq!(
            load_invocation(&connection, operation_id).unwrap().state,
            PluginInvocationState::DispatchingHttp
        );

        let committed = commit_invocation_for_test(&mut connection, plan(request), now).unwrap();
        assert_eq!(committed.cursor.unwrap().revision, head);
        assert!(committed.mutation.is_none());
        assert_eq!(
            load_invocation(&connection, operation_id).unwrap_err(),
            RepositoryError::NotFound
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap() as u64,
            head
        );
    }

    #[test]
    fn ordinary_cursor_cas_and_replay_are_revision_neutral() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_180, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), false, now).unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let request = AdvancePluginCursorRequest {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            expected: PluginCursorPosition::from(&cursor),
            next: PluginCursorPosition {
                event_epoch: cursor.event_epoch.clone(),
                revision: revision_before as u64,
                resync_required: false,
            },
        };
        let advanced = advance_cursor_for_test(&mut connection, request.clone(), now).unwrap();
        assert!(!advanced.resync_required);
        assert_eq!(
            advance_cursor_for_test(&mut connection, request.clone(), now).unwrap(),
            advanced
        );
        let mut stale_fence = request;
        stale_fence.package_generation += 1;
        assert_eq!(
            advance_cursor_for_test(&mut connection, stale_fence, now).unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            advance_cursor_for_test(
                &mut connection,
                AdvancePluginCursorRequest {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected: PluginCursorPosition {
                        event_epoch: cursor.event_epoch,
                        revision: 0,
                        resync_required: true,
                    },
                    next: PluginCursorPosition {
                        event_epoch: advanced.event_epoch.clone(),
                        revision: advanced.revision,
                        resync_required: true,
                    },
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let revision_after: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before);
    }

    #[test]
    fn resync_snapshot_pages_bind_head_filter_tail_mutations_and_enforce_retention() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_181, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[
                Capability::EventsSubscribe,
                Capability::ProjectsRead,
                Capability::Storage,
                Capability::TagsRead,
                Capability::TasksRead,
            ],
            now,
        );
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            granted.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let plugin = get_installed_plugin(&connection, granted.plugin_id).unwrap();

        let project_draft = |name: &str| ProjectDraft {
            name: EntityName::new(name).unwrap(),
            color: HexColor::new("#123456").unwrap(),
            icon: None,
            parent_id: None,
            favorite: false,
            archived: false,
            view: Default::default(),
            sort_order: SortOrder::default(),
        };
        let tag_draft = |name: &str| junban_app::TagDraft {
            name: TagName::new(name).unwrap(),
            color: HexColor::new("#654321").unwrap(),
        };
        let unchanged_project = ProjectId::new();
        let changed_project = ProjectId::new();
        let unchanged_tag = TagId::new();
        let changed_tag = TagId::new();
        let unchanged_task = TaskId::new();
        let changed_task = TaskId::new();
        catalog_ops::create_project(
            &mut connection,
            OperationId::new(),
            unchanged_project,
            project_draft("Unchanged project"),
            now,
        )
        .unwrap();
        catalog_ops::create_project(
            &mut connection,
            OperationId::new(),
            changed_project,
            project_draft("Changed project"),
            now,
        )
        .unwrap();
        catalog_ops::create_tag(
            &mut connection,
            OperationId::new(),
            unchanged_tag,
            tag_draft("Unchanged tag"),
            now,
        )
        .unwrap();
        catalog_ops::create_tag(
            &mut connection,
            OperationId::new(),
            changed_tag,
            tag_draft("Changed tag"),
            now,
        )
        .unwrap();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            unchanged_task,
            TaskDraft::new(TaskTitle::new("Unchanged task").unwrap()),
            now,
        )
        .unwrap();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            changed_task,
            TaskDraft::new(TaskTitle::new("Changed task").unwrap()),
            now,
        )
        .unwrap();

        let session = open_plugin_resync_session(
            &mut connection,
            BeginPluginResyncRequest {
                operation_id: OperationId::new(),
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
            },
            now,
        )
        .unwrap();
        catalog_ops::patch_project(
            &mut connection,
            OperationId::new(),
            changed_project,
            ProjectPatch {
                name: Some(EntityName::new("Updated project").unwrap()),
                ..ProjectPatch::default()
            },
            now,
        )
        .unwrap();
        catalog_ops::patch_tag(
            &mut connection,
            OperationId::new(),
            changed_tag,
            junban_app::TagPatch {
                name: Some(TagName::new("Updated tag").unwrap()),
                ..junban_app::TagPatch::default()
            },
            now,
        )
        .unwrap();
        task_ops::patch_task(
            &mut connection,
            OperationId::new(),
            changed_task,
            junban_app::TaskPatch {
                title: Some(TaskTitle::new("Updated task").unwrap()),
                ..junban_app::TaskPatch::default()
            },
            now,
        )
        .unwrap();

        for (kind, unchanged_id) in [
            (PluginSnapshotKind::Task, unchanged_task.to_string()),
            (PluginSnapshotKind::Project, unchanged_project.to_string()),
            (PluginSnapshotKind::Tag, unchanged_tag.to_string()),
        ] {
            let page = list_plugin_resync_page(
                &mut connection,
                PluginResyncPageRequest {
                    session: session.clone(),
                    kind,
                    after_id: None,
                },
                now,
            )
            .unwrap();
            assert!(page.exhausted);
            assert_eq!(page.items.len(), 1);
            assert_eq!(page.items[0].id(), unchanged_id);
            assert_eq!(page.next_after_id.as_deref(), Some(unchanged_id.as_str()));
            assert!(page.material_bytes <= PLUGIN_RESYNC_PAGE_BYTES_MAX);
            assert_eq!(
                page.material_bytes,
                serde_json::to_vec(&page).unwrap().len()
            );
        }

        connection
            .execute(
                "DELETE FROM events WHERE revision <= ?1",
                [as_i64(session.snapshot_revision + 1, "test revision").unwrap()],
            )
            .unwrap();
        assert_eq!(
            list_plugin_resync_page(
                &mut connection,
                PluginResyncPageRequest {
                    session,
                    kind: PluginSnapshotKind::Task,
                    after_id: None,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
    }

    #[test]
    fn invalidating_event_transitions_active_and_starting_catch_up_with_exact_replay() {
        for mode in [
            PluginDeliveryMode::Active,
            PluginDeliveryMode::StartingCatchUp,
        ] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_749_000_180, 0);
            let transition_now = Timestamp::constant(1_749_000_181, 0);
            let task_id = TaskId::new();
            task_ops::create_task(
                &mut connection,
                OperationId::new(),
                task_id,
                TaskDraft::new(TaskTitle::new("Invalidating baseline").unwrap()),
                now,
            )
            .unwrap();
            let installed = install_fixture(&mut connection, &store, now);
            let granted = grant_capabilities(
                &mut connection,
                &installed,
                &[Capability::EventsSubscribe],
                now,
            );
            let mut plugin = activate_plugin(&mut connection, &store, &granted, now);
            if mode == PluginDeliveryMode::StartingCatchUp {
                connection
                    .execute(
                        "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                        [plugin.plugin_id.as_str()],
                    )
                    .unwrap();
                plugin = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
            }
            let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
            append_invalidating_task_move(&mut connection, task_id, now);
            if mode == PluginDeliveryMode::Active {
                make_latest_event_malformed_direct(&connection, cursor.revision + 1);
            }
            let head_before = global_revision(&connection).unwrap();
            let event_count_before: i64 = connection
                .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
                .unwrap();
            let receipt_count_before: i64 = connection
                .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let operation_id = OperationId::new();
            let host_session_id = OperationId::new();
            let request = invalidating_event_request(
                &connection,
                &plugin,
                &cursor,
                operation_id,
                host_session_id,
                mode,
            );

            let collision_id: String = connection
                .query_row(
                    "SELECT operation_id FROM operation_receipts
                     WHERE operation_id <> ?1 ORDER BY operation_id LIMIT 1",
                    [operation_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            let mut collision = request.clone();
            collision.operation_id = OperationId::parse(&collision_id).unwrap();
            assert_eq!(
                mark_plugin_invalidating_event(&mut connection, collision, transition_now)
                    .unwrap_err(),
                RepositoryError::IdempotencyMismatch
            );

            let committed =
                mark_plugin_invalidating_event(&mut connection, request.clone(), transition_now)
                    .unwrap();
            assert_eq!(committed.event_epoch, cursor.event_epoch);
            assert_eq!(committed.revision, cursor.revision);
            assert!(committed.resync_required);
            assert_eq!(global_revision(&connection).unwrap(), head_before);
            assert_eq!(
                connection
                    .query_row::<i64, _, _>("SELECT COUNT(*) FROM events", [], |row| row.get(0))
                    .unwrap(),
                event_count_before
            );
            assert_eq!(
                connection
                    .query_row::<i64, _, _>("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                        row.get(0)
                    },)
                    .unwrap(),
                receipt_count_before + 1
            );
            let transitioned =
                get_installed_plugin(&connection, committed.plugin_id.clone()).unwrap();
            assert_eq!(transitioned.runtime_state, PluginRuntimeState::Starting);
            assert_eq!(transitioned.activation_epoch, plugin.activation_epoch + 1);
            assert_eq!(transitioned.failure_count, 0);
            assert_eq!(transitioned.last_error_code, None);
            assert_eq!(transitioned.next_retry_at, None);
            assert_eq!(
                mark_plugin_invalidating_event(&mut connection, request.clone(), transition_now,)
                    .unwrap(),
                committed
            );

            let (receipt_request, receipt_response): (String, String) = connection
                .query_row(
                    "SELECT request_json, response_json FROM operation_receipts
                     WHERE operation_id = ?1",
                    [operation_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!(!receipt_request.contains(&host_session_id.to_string()));
            assert!(!receipt_response.contains(&host_session_id.to_string()));
            validate_plugin_invalidating_event_receipt(
                operation_id,
                &receipt_request,
                &receipt_response,
            )
            .unwrap();

            let mut changed_hash = request.clone();
            changed_hash.event_content_sha256 = Sha256Digest::of(b"changed event");
            let mut changed_revision = request.clone();
            changed_revision.source_revision += 1;
            let mut changed_cursor = request.clone();
            changed_cursor.expected_cursor.revision -= 1;
            let mut changed_mode = request.clone();
            changed_mode.authority.mode = match mode {
                PluginDeliveryMode::Active => PluginDeliveryMode::StartingCatchUp,
                PluginDeliveryMode::StartingCatchUp => PluginDeliveryMode::Active,
                PluginDeliveryMode::StartingResync => unreachable!(),
            };
            let mut changed_session = request.clone();
            changed_session.authority.host_session_id = OperationId::new();
            let mut changed_generation = request.clone();
            changed_generation.authority.package_generation += 1;
            let mut changed_epoch = request;
            changed_epoch.authority.activation_epoch += 1;
            for changed in [changed_revision, changed_cursor] {
                assert_eq!(
                    mark_plugin_invalidating_event(&mut connection, changed, transition_now)
                        .unwrap_err(),
                    RepositoryError::Conflict
                );
            }
            for changed in [
                changed_hash,
                changed_mode,
                changed_session,
                changed_generation,
                changed_epoch,
            ] {
                assert_eq!(
                    mark_plugin_invalidating_event(&mut connection, changed, transition_now)
                        .unwrap_err(),
                    RepositoryError::IdempotencyMismatch
                );
            }
            validate_plugin_invalidating_event_receipts(&connection).unwrap();
        }
    }

    #[test]
    fn invalidating_event_carries_http_ambiguity_and_deletes_only_matching_non_http_rows() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_749_000_182, 0);
        let task_id = TaskId::new();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            task_id,
            TaskDraft::new(TaskTitle::new("Invalidating rows").unwrap()),
            now,
        )
        .unwrap();
        let target =
            install_named_fixture(&mut connection, &store, "invalidating-target", vec![], now);
        let sibling =
            install_named_fixture(&mut connection, &store, "invalidating-sibling", vec![], now);
        let target = grant_capabilities(
            &mut connection,
            &target,
            &[Capability::EventsSubscribe, Capability::Http],
            now,
        );
        let sibling = grant_capabilities(
            &mut connection,
            &sibling,
            &[Capability::EventsSubscribe],
            now,
        );
        let sibling = activate_plugin(&mut connection, &store, &sibling, now);
        let mut target = activate_plugin(&mut connection, &store, &target, now);

        let ambiguous_operation = OperationId::new();
        let ambiguous_delivery = OperationId::new();
        reserve_ambiguous(
            &mut connection,
            retention_test_invocation_request(&target, ambiguous_operation, ambiguous_delivery),
            now,
        );
        let mut target_rows = vec![(
            ambiguous_operation,
            ambiguous_delivery,
            PluginInvocationState::AmbiguousHttp,
        )];
        for (state, state_name, error_code) in [
            (PluginInvocationState::Reserved, "reserved", None::<&str>),
            (
                PluginInvocationState::EffectCommitting,
                "effect_committing",
                None,
            ),
            (
                PluginInvocationState::DispatchingHttp,
                "dispatching_http",
                None,
            ),
        ] {
            let operation_id = OperationId::new();
            let delivery_id = OperationId::new();
            connection
                .execute(
                    "INSERT INTO plugin_invocations(
                        operation_id, plugin_id, package_generation, activation_epoch,
                        hook_kind, entry_id, request_hash, delivery_id, state, error_code,
                        created_at, updated_at, retain_until
                     )
                     SELECT ?1, plugin_id, package_generation, activation_epoch,
                            hook_kind, entry_id, request_hash, ?2, ?3, ?4,
                            created_at, updated_at, retain_until
                     FROM plugin_invocations WHERE operation_id = ?5",
                    params![
                        operation_id.to_string(),
                        delivery_id.to_string(),
                        state_name,
                        error_code,
                        ambiguous_operation.to_string(),
                    ],
                )
                .unwrap();
            target_rows.push((operation_id, delivery_id, state));
        }
        let sibling_operation = OperationId::new();
        let sibling_delivery = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            retention_test_invocation_request(&sibling, sibling_operation, sibling_delivery),
            now,
        )
        .unwrap();
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                [target.plugin_id.as_str()],
            )
            .unwrap();
        target = get_installed_plugin(&connection, target.plugin_id).unwrap();

        let cursor = get_plugin_cursor(&connection, target.plugin_id.clone()).unwrap();
        append_invalidating_task_move(&mut connection, task_id, now);
        let head_before = global_revision(&connection).unwrap();
        let event_count_before: i64 = connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .unwrap();
        let request = invalidating_event_request(
            &connection,
            &target,
            &cursor,
            OperationId::new(),
            OperationId::new(),
            PluginDeliveryMode::StartingCatchUp,
        );
        mark_plugin_invalidating_event(&mut connection, request, now).unwrap();
        let transitioned = get_installed_plugin(&connection, target.plugin_id.clone()).unwrap();
        for (operation_id, delivery_id, old_state) in target_rows {
            match old_state {
                PluginInvocationState::Reserved | PluginInvocationState::EffectCommitting => {
                    assert_eq!(
                        load_invocation(&connection, operation_id).unwrap_err(),
                        RepositoryError::NotFound
                    );
                }
                PluginInvocationState::DispatchingHttp | PluginInvocationState::AmbiguousHttp => {
                    let row = load_invocation(&connection, operation_id).unwrap();
                    assert_eq!(row.state, PluginInvocationState::AmbiguousHttp);
                    assert_eq!(row.error_code.as_deref(), Some("http_ambiguous"));
                    assert_eq!(row.delivery_operation_id, delivery_id);
                    assert_eq!(row.activation_epoch, transitioned.activation_epoch);
                }
            }
        }
        let sibling_row = load_invocation(&connection, sibling_operation).unwrap();
        assert_eq!(sibling_row.plugin_id, sibling.plugin_id);
        assert_eq!(sibling_row.activation_epoch, sibling.activation_epoch);
        assert_eq!(sibling_row.delivery_operation_id, sibling_delivery);
        assert_eq!(global_revision(&connection).unwrap(), head_before);
        assert_eq!(
            connection
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM events", [], |row| row.get(0))
                .unwrap(),
            event_count_before
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn invalidating_event_receipt_corruption_fails_open_backup_and_restore_preflight() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_749_000_183, 0);
        let task_id = TaskId::new();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            task_id,
            TaskDraft::new(TaskTitle::new("Invalidating receipt").unwrap()),
            now,
        )
        .unwrap();
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe],
            now,
        );
        let active = activate_plugin(&mut connection, &store, &granted, now);
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                [active.plugin_id.as_str()],
            )
            .unwrap();
        let plugin = get_installed_plugin(&connection, active.plugin_id).unwrap();
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        append_invalidating_task_move(&mut connection, task_id, now);
        let operation_id = OperationId::new();
        let request = invalidating_event_request(
            &connection,
            &plugin,
            &cursor,
            operation_id,
            OperationId::new(),
            PluginDeliveryMode::StartingCatchUp,
        );
        mark_plugin_invalidating_event(&mut connection, request, now).unwrap();
        let (canonical_request, canonical_response): (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let replace_receipt = |connection: &Connection, request_json: &str, response_json: &str| {
            connection
                .execute(
                    "UPDATE operation_receipts
                     SET request_json = ?2, response_json = ?3 WHERE operation_id = ?1",
                    params![operation_id.to_string(), request_json, response_json],
                )
                .unwrap();
        };

        let mut request_corruption: PluginInvalidatingEventReceiptRequest =
            serde_json::from_str(&canonical_request).unwrap();
        request_corruption.host_session_sha256 = Sha256Digest::of(b"wrong session digest");
        let request_corruption = canonical_json(&request_corruption).unwrap();
        replace_receipt(&connection, &request_corruption, &canonical_response);
        assert!(validate_plugin_invalidating_event_receipts(&connection).is_err());
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        drop(connection);
        drop(store);
        assert!(crate::ProfileOwner::open(&profile.path).is_err());

        let repair = Connection::open(profile.path.join(crate::DATABASE_FILE)).unwrap();
        replace_receipt(&repair, &canonical_request, &canonical_response);
        drop(repair);
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let mut response_corruption: PluginCursorRestartReceiptResponse =
            serde_json::from_str(&canonical_response).unwrap();
        response_corruption.post_transition.activation_epoch += 1;
        let response_corruption = canonical_json(&response_corruption).unwrap();
        replace_receipt(&connection, &canonical_request, &response_corruption);
        assert!(validate_plugin_invalidating_event_receipts(&connection).is_err());
        replace_receipt(&connection, &canonical_request, &canonical_response);

        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let corrupt_candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        {
            let candidate = Connection::open(corrupt_candidate.path()).unwrap();
            replace_receipt(&candidate, &request_corruption, &canonical_response);
        }
        assert!(
            crate::backup_ops::restore_backup(&mut connection, &profile.path, corrupt_candidate)
                .is_err()
        );
        validate_plugin_invalidating_event_receipts(&connection).unwrap();

        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        crate::backup_ops::restore_backup(&mut connection, &profile.path, candidate).unwrap();
        validate_plugin_invalidating_event_receipts(&connection).unwrap();
        drop(connection);
        drop(store);
        let owner = crate::ProfileOwner::open(&profile.path).unwrap();
        drop(owner);
    }

    #[test]
    fn invalidating_event_rejects_represented_irrelevant_and_stale_authority() {
        enum EventCase {
            Represented,
            Irrelevant,
        }
        for event_case in [EventCase::Represented, EventCase::Irrelevant] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_749_000_182, 0);
            let installed = install_fixture(&mut connection, &store, now);
            let granted = grant_capabilities(
                &mut connection,
                &installed,
                &[Capability::EventsSubscribe],
                now,
            );
            let active = activate_plugin(&mut connection, &store, &granted, now);
            connection
                .execute(
                    "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                    [active.plugin_id.as_str()],
                )
                .unwrap();
            let plugin = get_installed_plugin(&connection, active.plugin_id).unwrap();
            let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
            match event_case {
                EventCase::Represented => {
                    task_ops::create_task(
                        &mut connection,
                        OperationId::new(),
                        TaskId::new(),
                        TaskDraft::new(TaskTitle::new("Represented event").unwrap()),
                        now,
                    )
                    .unwrap();
                }
                EventCase::Irrelevant => {
                    append_irrelevant_settings_event(&mut connection, now, "#112233");
                }
            }
            let base = invalidating_event_request(
                &connection,
                &plugin,
                &cursor,
                OperationId::new(),
                OperationId::new(),
                PluginDeliveryMode::StartingCatchUp,
            );
            assert_eq!(
                mark_plugin_invalidating_event(&mut connection, base.clone(), now).unwrap_err(),
                RepositoryError::Conflict
            );
            let mut stale_hash = base.clone();
            stale_hash.operation_id = OperationId::new();
            stale_hash.event_content_sha256 = Sha256Digest::of(b"stale");
            let mut stale_generation = base.clone();
            stale_generation.operation_id = OperationId::new();
            stale_generation.authority.package_generation += 1;
            let mut stale_epoch = base.clone();
            stale_epoch.operation_id = OperationId::new();
            stale_epoch.authority.activation_epoch += 1;
            let mut stale_cursor = base.clone();
            stale_cursor.operation_id = OperationId::new();
            stale_cursor.expected_cursor.event_epoch = OperationId::new().to_string();
            let mut stale_mode = base;
            stale_mode.operation_id = OperationId::new();
            stale_mode.authority.mode = PluginDeliveryMode::Active;
            for stale in [
                stale_hash,
                stale_generation,
                stale_epoch,
                stale_cursor,
                stale_mode,
            ] {
                assert_eq!(
                    mark_plugin_invalidating_event(&mut connection, stale, now).unwrap_err(),
                    RepositoryError::Conflict
                );
            }
        }
    }

    #[test]
    fn retention_loss_authority_transitions_active_and_starting_catch_up_with_exact_replay() {
        for mode in [
            PluginDeliveryMode::Active,
            PluginDeliveryMode::StartingCatchUp,
        ] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_750_000_180, 0);
            let transition_now = Timestamp::constant(1_750_000_181, 0);
            let installed = install_fixture(&mut connection, &store, now);
            let granted = grant_capabilities(
                &mut connection,
                &installed,
                &[Capability::EventsSubscribe],
                now,
            );
            let mut plugin = activate_plugin(&mut connection, &store, &granted, now);
            if mode == PluginDeliveryMode::StartingCatchUp {
                connection
                    .execute(
                        "UPDATE plugins
                         SET runtime_state = 'starting', failure_count = 2,
                             last_error_code = 'timeout'
                         WHERE plugin_id = ?1",
                        [plugin.plugin_id.as_str()],
                    )
                    .unwrap();
                plugin = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
            }
            let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
            create_retention_gap(&mut connection, &cursor, now);
            let head_before = global_revision(&connection).unwrap();
            let receipt_count_before: i64 = connection
                .query_row("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                    row.get(0)
                })
                .unwrap();
            let operation_id = OperationId::new();
            let host_session_id = OperationId::new();
            let request =
                retention_loss_request(&plugin, &cursor, operation_id, host_session_id, mode);

            let collision_id = connection
                .query_row::<String, _, _>(
                    "SELECT operation_id FROM operation_receipts
                     WHERE operation_id <> ?1 ORDER BY operation_id LIMIT 1",
                    [operation_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap();
            let mut collision = request.clone();
            collision.operation_id = OperationId::parse(&collision_id).unwrap();
            assert_eq!(
                mark_plugin_retention_loss(&mut connection, collision, transition_now).unwrap_err(),
                RepositoryError::IdempotencyMismatch
            );

            let committed =
                mark_plugin_retention_loss(&mut connection, request.clone(), transition_now)
                    .unwrap();
            assert_eq!(committed.plugin_id, plugin.plugin_id);
            assert_eq!(committed.event_epoch, cursor.event_epoch);
            assert_eq!(committed.revision, cursor.revision);
            assert!(committed.resync_required);
            assert_eq!(global_revision(&connection).unwrap(), head_before);
            assert_eq!(
                connection
                    .query_row::<i64, _, _>("SELECT COUNT(*) FROM operation_receipts", [], |row| {
                        row.get(0)
                    },)
                    .unwrap(),
                receipt_count_before + 1
            );
            let transitioned =
                get_installed_plugin(&connection, committed.plugin_id.clone()).unwrap();
            assert!(transitioned.desired_enabled);
            assert_eq!(transitioned.runtime_state, PluginRuntimeState::Starting);
            assert_eq!(transitioned.package_generation, plugin.package_generation);
            assert_eq!(transitioned.activation_epoch, plugin.activation_epoch + 1);
            assert_eq!(transitioned.failure_count, 0);
            assert_eq!(transitioned.last_error_code, None);
            assert_eq!(transitioned.next_retry_at, None);
            assert_eq!(
                mark_plugin_retention_loss(&mut connection, request.clone(), transition_now,)
                    .unwrap(),
                committed
            );

            let (receipt_request, receipt_response): (String, String) = connection
                .query_row(
                    "SELECT request_json, response_json FROM operation_receipts
                     WHERE operation_id = ?1",
                    [operation_id.to_string()],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!(!receipt_request.contains(&host_session_id.to_string()));
            assert!(!receipt_response.contains(&host_session_id.to_string()));
            validate_plugin_retention_loss_receipt(
                operation_id,
                &receipt_request,
                &receipt_response,
            )
            .unwrap();

            let mut changed_session = request.clone();
            changed_session.authority.host_session_id = OperationId::new();
            let mut changed_mode = request.clone();
            changed_mode.authority.mode = match mode {
                PluginDeliveryMode::Active => PluginDeliveryMode::StartingCatchUp,
                PluginDeliveryMode::StartingCatchUp => PluginDeliveryMode::Active,
                PluginDeliveryMode::StartingResync => unreachable!(),
            };
            let mut changed_cursor = request.clone();
            changed_cursor.expected_cursor.revision -= 1;
            let mut changed_authority = request.clone();
            changed_authority.authority.package_generation += 1;
            for changed in [
                changed_session,
                changed_mode,
                changed_cursor,
                changed_authority,
            ] {
                assert_eq!(
                    mark_plugin_retention_loss(&mut connection, changed, transition_now)
                        .unwrap_err(),
                    RepositoryError::IdempotencyMismatch
                );
            }
            crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

            drop(connection);
            drop(store);
            let owner = crate::ProfileOwner::open(&profile.path).unwrap();
            drop(owner);
        }
    }

    #[test]
    fn retention_loss_authority_rejects_no_gap_and_every_stale_sqlite_identity() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_182, 0);
        let transition_now = Timestamp::constant(1_800_000_183, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        let request = retention_loss_request(
            &plugin,
            &cursor,
            OperationId::new(),
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        assert_eq!(
            mark_plugin_retention_loss(&mut connection, request, transition_now).unwrap_err(),
            RepositoryError::Conflict
        );

        create_retention_gap(&mut connection, &cursor, now);
        let base = retention_loss_request(
            &plugin,
            &cursor,
            OperationId::new(),
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        let mut wrong_generation = base.clone();
        wrong_generation.operation_id = OperationId::new();
        wrong_generation.authority.package_generation += 1;
        let mut wrong_epoch = base.clone();
        wrong_epoch.operation_id = OperationId::new();
        wrong_epoch.authority.activation_epoch += 1;
        let mut wrong_revision = base.clone();
        wrong_revision.operation_id = OperationId::new();
        wrong_revision.expected_cursor.revision -= 1;
        let mut wrong_event_epoch = base.clone();
        wrong_event_epoch.operation_id = OperationId::new();
        wrong_event_epoch.expected_cursor.event_epoch = OperationId::new().to_string();
        let mut wrong_mode = base.clone();
        wrong_mode.operation_id = OperationId::new();
        wrong_mode.authority.mode = PluginDeliveryMode::StartingCatchUp;
        let mut already_resyncing = base.clone();
        already_resyncing.operation_id = OperationId::new();
        already_resyncing.expected_cursor.resync_required = true;
        for stale in [
            wrong_generation,
            wrong_epoch,
            wrong_revision,
            wrong_event_epoch,
            wrong_mode,
            already_resyncing,
        ] {
            assert_eq!(
                mark_plugin_retention_loss(&mut connection, stale, transition_now).unwrap_err(),
                RepositoryError::Conflict
            );
        }

        connection
            .execute(
                "UPDATE plugins SET activation_epoch = ?2 WHERE plugin_id = ?1",
                params![plugin.plugin_id.as_str(), i64::MAX],
            )
            .unwrap();
        let overflow_plugin = get_installed_plugin(&connection, plugin.plugin_id.clone()).unwrap();
        let overflow = retention_loss_request(
            &overflow_plugin,
            &cursor,
            OperationId::new(),
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        assert_eq!(
            mark_plugin_retention_loss(&mut connection, overflow, transition_now).unwrap_err(),
            RepositoryError::Conflict
        );
        connection
            .execute(
                "UPDATE plugins SET activation_epoch = ?2 WHERE plugin_id = ?1",
                params![
                    plugin.plugin_id.as_str(),
                    as_i64(plugin.activation_epoch, "activation epoch").unwrap()
                ],
            )
            .unwrap();

        let committed =
            mark_plugin_retention_loss(&mut connection, base.clone(), transition_now).unwrap();
        let mut stale_after_transition = base.clone();
        stale_after_transition.operation_id = OperationId::new();
        assert_eq!(
            mark_plugin_retention_loss(&mut connection, stale_after_transition, transition_now,)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        let transitioned = get_installed_plugin(&connection, committed.plugin_id.clone()).unwrap();
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            transitioned.plugin_id,
            false,
            Timestamp::constant(1_800_000_184, 0),
        )
        .unwrap();
        assert_eq!(
            mark_plugin_retention_loss(&mut connection, base, transition_now).unwrap_err(),
            RepositoryError::Conflict
        );
        validate_plugin_retention_loss_receipts(&connection).unwrap();
    }

    #[test]
    fn retention_loss_carries_only_matching_http_ambiguity_identity_into_the_new_epoch() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_185, 0);
        let transition_now = Timestamp::constant(1_800_000_186, 0);
        let target =
            install_named_fixture(&mut connection, &store, "retention-target", vec![], now);
        let sibling =
            install_named_fixture(&mut connection, &store, "retention-sibling", vec![], now);
        let target = grant_capabilities(
            &mut connection,
            &target,
            &[Capability::EventsSubscribe, Capability::Http],
            now,
        );
        let sibling = grant_capabilities(
            &mut connection,
            &sibling,
            &[Capability::EventsSubscribe, Capability::Http],
            now,
        );
        let target = activate_plugin(&mut connection, &store, &target, now);
        let sibling = activate_plugin(&mut connection, &store, &sibling, now);

        let already_ambiguous_operation = OperationId::new();
        let already_ambiguous_delivery = OperationId::new();
        reserve_ambiguous(
            &mut connection,
            retention_test_invocation_request(
                &target,
                already_ambiguous_operation,
                already_ambiguous_delivery,
            ),
            now,
        );
        let dispatching_operation = OperationId::new();
        let dispatching_delivery = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            retention_test_invocation_request(&target, dispatching_operation, dispatching_delivery),
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: dispatching_operation,
                plugin_id: target.plugin_id.clone(),
                package_generation: target.package_generation,
                activation_epoch: target.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        let sibling_operation = OperationId::new();
        let sibling_delivery = OperationId::new();
        reserve_ambiguous(
            &mut connection,
            retention_test_invocation_request(&sibling, sibling_operation, sibling_delivery),
            now,
        );

        let other_generation_operation = OperationId::new();
        let other_generation_delivery = OperationId::new();
        connection
            .execute_batch("PRAGMA foreign_keys = OFF")
            .unwrap();
        connection
            .execute(
                "INSERT INTO plugin_invocations(
                    operation_id, plugin_id, package_generation, activation_epoch,
                    hook_kind, entry_id, request_hash, delivery_id, state, error_code,
                    created_at, updated_at, retain_until
                 )
                 SELECT ?1, plugin_id, package_generation + 1, activation_epoch,
                        hook_kind, entry_id, request_hash, ?2, state, error_code,
                        created_at, updated_at, retain_until
                 FROM plugin_invocations WHERE operation_id = ?3",
                params![
                    other_generation_operation.to_string(),
                    other_generation_delivery.to_string(),
                    already_ambiguous_operation.to_string(),
                ],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();

        let cursor = get_plugin_cursor(&connection, target.plugin_id.clone()).unwrap();
        create_retention_gap(&mut connection, &cursor, now);
        let request = retention_loss_request(
            &target,
            &cursor,
            OperationId::new(),
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        mark_plugin_retention_loss(&mut connection, request, transition_now).unwrap();
        let transitioned = get_installed_plugin(&connection, target.plugin_id.clone()).unwrap();
        for (operation_id, delivery_id) in [
            (already_ambiguous_operation, already_ambiguous_delivery),
            (dispatching_operation, dispatching_delivery),
        ] {
            let invocation = load_invocation(&connection, operation_id).unwrap();
            assert_eq!(invocation.state, PluginInvocationState::AmbiguousHttp);
            assert_eq!(invocation.error_code.as_deref(), Some("http_ambiguous"));
            assert_eq!(invocation.activation_epoch, transitioned.activation_epoch);
            assert_eq!(invocation.delivery_operation_id, delivery_id);
        }
        let untouched_sibling = load_invocation(&connection, sibling_operation).unwrap();
        assert_eq!(untouched_sibling.plugin_id, sibling.plugin_id);
        assert_eq!(untouched_sibling.activation_epoch, sibling.activation_epoch);
        assert_eq!(untouched_sibling.delivery_operation_id, sibling_delivery);
        let untouched_generation =
            load_invocation(&connection, other_generation_operation).unwrap();
        assert_eq!(
            untouched_generation.package_generation,
            target.package_generation + 1
        );
        assert_eq!(
            untouched_generation.activation_epoch,
            target.activation_epoch
        );
        assert_eq!(
            untouched_generation.delivery_operation_id,
            other_generation_delivery
        );

        connection
            .execute(
                "DELETE FROM plugin_invocations WHERE operation_id = ?1",
                [other_generation_operation.to_string()],
            )
            .unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn retention_loss_deletes_only_matching_reserved_or_effect_committing_rows() {
        for target_state in [
            PluginInvocationState::Reserved,
            PluginInvocationState::EffectCommitting,
        ] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_800_000_187, 0);
            let transition_now = Timestamp::constant(1_800_000_188, 0);
            let target =
                install_named_fixture(&mut connection, &store, "deletion-target", vec![], now);
            let sibling =
                install_named_fixture(&mut connection, &store, "deletion-sibling", vec![], now);
            let target = grant_capabilities(
                &mut connection,
                &target,
                &[Capability::EventsSubscribe],
                now,
            );
            let sibling = grant_capabilities(
                &mut connection,
                &sibling,
                &[Capability::EventsSubscribe],
                now,
            );
            let target = activate_plugin(&mut connection, &store, &target, now);
            let sibling = activate_plugin(&mut connection, &store, &sibling, now);
            let target_operation = OperationId::new();
            let target_delivery = OperationId::new();
            reserve_invocation_for_test(
                &mut connection,
                retention_test_invocation_request(&target, target_operation, target_delivery),
                now,
            )
            .unwrap();
            if target_state == PluginInvocationState::EffectCommitting {
                transition_invocation_for_test(
                    &mut connection,
                    TransitionPluginInvocationRequest {
                        operation_id: target_operation,
                        plugin_id: target.plugin_id.clone(),
                        package_generation: target.package_generation,
                        activation_epoch: target.activation_epoch,
                        expected_state: PluginInvocationState::Reserved,
                        next_state: PluginInvocationState::EffectCommitting,
                    },
                    now,
                )
                .unwrap();
            }
            let sibling_operation = OperationId::new();
            let sibling_delivery = OperationId::new();
            reserve_invocation_for_test(
                &mut connection,
                retention_test_invocation_request(&sibling, sibling_operation, sibling_delivery),
                now,
            )
            .unwrap();
            if target_state == PluginInvocationState::Reserved {
                transition_invocation_for_test(
                    &mut connection,
                    TransitionPluginInvocationRequest {
                        operation_id: sibling_operation,
                        plugin_id: sibling.plugin_id.clone(),
                        package_generation: sibling.package_generation,
                        activation_epoch: sibling.activation_epoch,
                        expected_state: PluginInvocationState::Reserved,
                        next_state: PluginInvocationState::EffectCommitting,
                    },
                    now,
                )
                .unwrap();
            }

            let cursor = get_plugin_cursor(&connection, target.plugin_id.clone()).unwrap();
            create_retention_gap(&mut connection, &cursor, now);
            let request = retention_loss_request(
                &target,
                &cursor,
                OperationId::new(),
                OperationId::new(),
                PluginDeliveryMode::Active,
            );
            let committed =
                mark_plugin_retention_loss(&mut connection, request.clone(), transition_now)
                    .unwrap();
            assert_eq!(
                load_invocation(&connection, target_operation).unwrap_err(),
                RepositoryError::NotFound
            );
            let untouched = load_invocation(&connection, sibling_operation).unwrap();
            assert_eq!(untouched.plugin_id, sibling.plugin_id);
            assert_eq!(untouched.activation_epoch, sibling.activation_epoch);
            assert_eq!(untouched.delivery_operation_id, sibling_delivery);
            assert_eq!(
                mark_plugin_retention_loss(&mut connection, request, transition_now).unwrap(),
                committed
            );
            crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        }
    }

    #[test]
    fn retention_loss_receipts_reject_corruption_and_survive_reopen_backup_and_restore() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_750_000_189, 0);
        let transition_now = Timestamp::constant(1_750_000_190, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        create_retention_gap(&mut connection, &cursor, now);
        let operation_id = OperationId::new();
        let request = retention_loss_request(
            &plugin,
            &cursor,
            operation_id,
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        mark_plugin_retention_loss(&mut connection, request, transition_now).unwrap();
        let (canonical_request, canonical_response): (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let replace_receipt = |connection: &Connection, request_json: &str, response_json: &str| {
            connection
                .execute(
                    "UPDATE operation_receipts
                         SET request_json = ?2, response_json = ?3
                         WHERE operation_id = ?1",
                    params![operation_id.to_string(), request_json, response_json],
                )
                .unwrap();
        };

        for (request_json, response_json) in [
            ("{".to_owned(), canonical_response.clone()),
            (format!(" {canonical_request}"), canonical_response.clone()),
            (canonical_request.clone(), "{".to_owned()),
            (canonical_request.clone(), format!(" {canonical_response}")),
        ] {
            replace_receipt(&connection, &request_json, &response_json);
            assert!(validate_plugin_retention_loss_receipts(&connection).is_err());
            replace_receipt(&connection, &canonical_request, &canonical_response);
        }

        let mut digest_corruption: PluginRetentionLossReceiptRequest =
            serde_json::from_str(&canonical_request).unwrap();
        digest_corruption.request_sha256 = Sha256Digest::of(b"corrupted request digest");
        let digest_corruption = canonical_json(&digest_corruption).unwrap();
        replace_receipt(&connection, &digest_corruption, &canonical_response);
        assert!(validate_plugin_retention_loss_receipts(&connection).is_err());
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        drop(connection);
        drop(store);
        assert!(crate::ProfileOwner::open(&profile.path).is_err());
        let repair = Connection::open(profile.path.join(crate::DATABASE_FILE)).unwrap();
        replace_receipt(&repair, &canonical_request, &canonical_response);
        drop(repair);
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();

        let mut response_corruption: PluginCursorRestartReceiptResponse =
            serde_json::from_str(&canonical_response).unwrap();
        response_corruption.post_transition.activation_epoch += 1;
        let response_corruption = canonical_json(&response_corruption).unwrap();
        replace_receipt(&connection, &canonical_request, &response_corruption);
        assert!(validate_plugin_retention_loss_receipts(&connection).is_err());
        replace_receipt(&connection, &canonical_request, &canonical_response);
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let corrupt_candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        {
            let candidate_connection = Connection::open(corrupt_candidate.path()).unwrap();
            candidate_connection
                .execute(
                    "UPDATE operation_receipts SET request_json = ?2
                     WHERE operation_id = ?1",
                    params![operation_id.to_string(), digest_corruption],
                )
                .unwrap();
        }
        assert!(
            crate::backup_ops::restore_backup(&mut connection, &profile.path, corrupt_candidate,)
                .is_err()
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        crate::backup_ops::restore_backup(&mut connection, &profile.path, candidate).unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        crate::backup_ops::create_backup(&connection, &profile.path).unwrap();

        drop(connection);
        drop(store);
        let owner = crate::ProfileOwner::open(&profile.path).unwrap();
        drop(owner);
    }

    #[test]
    fn retention_loss_same_operation_race_commits_one_epoch_and_replays_one_response() {
        let profile = TestProfile::new();
        let mut setup = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_191, 0);
        let transition_now = Timestamp::constant(1_800_000_192, 0);
        let installed = install_fixture(&mut setup, &store, now);
        let granted =
            grant_capabilities(&mut setup, &installed, &[Capability::EventsSubscribe], now);
        let plugin = activate_plugin(&mut setup, &store, &granted, now);
        let cursor = get_plugin_cursor(&setup, plugin.plugin_id.clone()).unwrap();
        create_retention_gap(&mut setup, &cursor, now);
        let head = global_revision(&setup).unwrap();
        let operation_id = OperationId::new();
        let request = retention_loss_request(
            &plugin,
            &cursor,
            operation_id,
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        drop(setup);
        drop(store);

        let first_connection = profile.connection();
        let second_connection = profile.connection();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let run = |mut connection: Connection,
                   request: MarkPluginRetentionLossRequest,
                   barrier: std::sync::Arc<std::sync::Barrier>| {
            std::thread::spawn(move || {
                barrier.wait();
                mark_plugin_retention_loss(&mut connection, request, transition_now)
            })
        };
        let first = run(first_connection, request.clone(), barrier.clone());
        let second = run(second_connection, request, barrier.clone());
        barrier.wait();
        let first = first.join().unwrap().unwrap();
        let second = second.join().unwrap().unwrap();
        assert_eq!(first, second);

        let connection = profile.connection();
        let transitioned = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        assert_eq!(transitioned.activation_epoch, plugin.activation_epoch + 1);
        assert_eq!(global_revision(&connection).unwrap(), head);
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1",
                    [operation_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn ordinary_cursor_loss_requires_resync_without_disabling_the_plugin() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_182, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        let http_operation = OperationId::new();
        let delivery_operation = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::HandleEvent,
                entry: PluginManifestEntry::Event {
                    event_id: PluginId::parse("task-created").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"retention-loss-http"),
                delivery_operation_id: delivery_operation,
                resync_session: None,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::DispatchingHttp,
                next_state: PluginInvocationState::AmbiguousHttp,
            },
            now,
        )
        .unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), false, now).unwrap();
        set_community_plugin_policy(&mut connection, OperationId::new(), true, now).unwrap();
        let head: u64 = connection
            .query_row::<i64, _, _>(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap() as u64;
        connection
            .execute(
                "DELETE FROM events WHERE revision < ?1",
                [as_i64(head, "test head").unwrap()],
            )
            .unwrap();
        let request = AdvancePluginCursorRequest {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            expected: PluginCursorPosition::from(&cursor),
            next: PluginCursorPosition {
                event_epoch: cursor.event_epoch.clone(),
                revision: head,
                resync_required: false,
            },
        };
        let resync = advance_cursor_for_test(&mut connection, request.clone(), now).unwrap();
        assert_eq!(
            advance_cursor_for_test(&mut connection, request, now).unwrap(),
            resync
        );
        assert!(resync.resync_required);
        assert_eq!(resync.revision, cursor.revision);
        let resyncing = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        assert_eq!(resyncing.runtime_state, PluginRuntimeState::Starting);
        assert!(resyncing.desired_enabled);
        assert_eq!(resyncing.activation_epoch, plugin.activation_epoch + 1);
        let ambiguous = load_invocation(&connection, http_operation).unwrap();
        assert_eq!(ambiguous.state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(ambiguous.activation_epoch, resyncing.activation_epoch);
        assert_eq!(ambiguous.delivery_operation_id, delivery_operation);
        let ordinary = ReservePluginInvocationRequest {
            operation_id: OperationId::new(),
            plugin_id: resyncing.plugin_id.clone(),
            package_generation: resyncing.package_generation,
            activation_epoch: resyncing.activation_epoch,
            hook_kind: PluginHookKind::HandleEvent,
            entry: PluginManifestEntry::Event {
                event_id: PluginId::parse("task-created").unwrap(),
            },
            request_sha256: Sha256Digest::of(b"retained-event"),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        assert_eq!(
            reserve_invocation_for_test(&mut connection, ordinary, now).unwrap_err(),
            RepositoryError::Conflict
        );
        let resync_operation_id = OperationId::new();
        let session = open_plugin_resync_session(
            &mut connection,
            BeginPluginResyncRequest {
                operation_id: resync_operation_id,
                plugin_id: resyncing.plugin_id.clone(),
                package_generation: resyncing.package_generation,
                activation_epoch: resyncing.activation_epoch,
            },
            now,
        )
        .unwrap();
        let resync_invocation = reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id: resync_operation_id,
                plugin_id: resyncing.plugin_id,
                package_generation: resyncing.package_generation,
                activation_epoch: resyncing.activation_epoch,
                hook_kind: PluginHookKind::Resync,
                entry: PluginManifestEntry::Resync,
                request_sha256: plugin_resync_request_hash(&session),
                delivery_operation_id: OperationId::new(),
                resync_session: Some(session.clone()),
            },
            now,
        )
        .unwrap();
        let invocation = resync_invocation.invocation().unwrap().clone();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: invocation.operation_id,
                plugin_id: invocation.plugin_id.clone(),
                package_generation: invocation.package_generation,
                activation_epoch: invocation.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();
        commit_invocation_for_test(
            &mut connection,
            plan(CommitPluginInvocationRequest {
                invocation_operation_id: invocation.operation_id,
                plugin_id: invocation.plugin_id.clone(),
                package_generation: invocation.package_generation,
                activation_epoch: invocation.activation_epoch,
                child_operation_id: None,
                domain_effect: None,
                kv_patch: None,
                resync_kv: Some(PluginResyncKvCommit::Leave),
                cursor: Some(AdvancePluginCursorRequest {
                    plugin_id: invocation.plugin_id,
                    package_generation: invocation.package_generation,
                    activation_epoch: invocation.activation_epoch,
                    expected: session.expected_cursor.clone(),
                    next: PluginCursorPosition {
                        event_epoch: session.snapshot_event_epoch.clone(),
                        revision: session.snapshot_revision,
                        resync_required: false,
                    },
                }),
                resync_session: Some(session),
            }),
            now,
        )
        .unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap() as u64,
            head
        );
    }

    #[test]
    fn finalize_resync_applies_leave_replace_and_zero_replace_without_event() {
        for (choice, staged, expected) in [
            (
                FinalKvChoice::LeaveKv,
                vec![("ignored".to_owned(), vec![9])],
                vec![("old".to_owned(), vec![1])],
            ),
            (
                FinalKvChoice::ReplaceKvWithStagedSegments,
                vec![("new".to_owned(), vec![2, 3])],
                vec![("new".to_owned(), vec![2, 3])],
            ),
            (
                FinalKvChoice::ReplaceKvWithStagedSegments,
                Vec::new(),
                Vec::new(),
            ),
        ] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_800_000_185, 20);
            let (request, plugin, snapshot_revision) =
                prepare_finalize_request(&mut connection, &store, now, staged, choice);
            connection
                .execute(
                    "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                     VALUES (?1, 'old', X'01', ?2)",
                    params![plugin.plugin_id.as_str(), now.to_string()],
                )
                .unwrap();
            let head_before: i64 = connection
                .query_row(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let outcome = finalize_plugin_resync(&mut connection, request, now).unwrap();
            assert_eq!(
                outcome,
                FinalizePluginResyncOutcome::Committed(PluginEventCursor {
                    plugin_id: plugin.plugin_id.clone(),
                    event_epoch: get_plugin_cursor(&connection, plugin.plugin_id.clone())
                        .unwrap()
                        .event_epoch,
                    revision: snapshot_revision,
                    resync_required: false,
                    updated_at: now,
                })
            );
            let actual: Vec<_> = list_plugin_kv(&connection, plugin.plugin_id.clone())
                .unwrap()
                .into_iter()
                .map(|entry| (entry.key, entry.value))
                .collect();
            assert_eq!(actual, expected);
            assert!(list_plugin_invocations(&connection).unwrap().is_empty());
            assert_eq!(
                connection
                    .query_row::<i64, _, _>(
                        "SELECT global_revision FROM app_state WHERE singleton = 1",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap(),
                head_before
            );
        }
    }

    #[test]
    fn finalize_resync_transaction_failure_injection_rolls_back_before_commit_only() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_185, 21);
        let (request, plugin, _) = prepare_finalize_request(
            &mut connection,
            &store,
            now,
            vec![("new".to_owned(), vec![2])],
            FinalKvChoice::ReplaceKvWithStagedSegments,
        );
        connection
            .execute(
                "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                 VALUES (?1, 'old', X'01', ?2)",
                params![plugin.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        let injected = || RepositoryError::Storage("injected finalize failure".to_owned());
        assert_eq!(
            finalize_plugin_resync_with(
                &mut connection,
                request.clone(),
                now,
                || Err(injected()),
                || Ok(()),
            ),
            Err(injected())
        );
        assert!(
            get_plugin_cursor(&connection, plugin.plugin_id.clone())
                .unwrap()
                .resync_required
        );
        assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 1);
        assert_eq!(
            list_plugin_kv(&connection, plugin.plugin_id.clone()).unwrap()[0].key,
            "old"
        );
        assert_eq!(
            finalize_plugin_resync_with(
                &mut connection,
                request.clone(),
                now,
                || Ok(()),
                || Err(injected()),
            ),
            Err(injected())
        );
        assert!(
            !get_plugin_cursor(&connection, plugin.plugin_id.clone())
                .unwrap()
                .resync_required
        );
        assert!(list_plugin_invocations(&connection).unwrap().is_empty());
        assert_eq!(
            list_plugin_kv(&connection, plugin.plugin_id).unwrap()[0].key,
            "new"
        );
        assert_eq!(
            finalize_plugin_resync(&mut connection, request, now),
            Err(RepositoryError::NotFound)
        );
    }

    #[test]
    fn finalize_resync_rechecks_every_authority_field_under_the_lock() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_185, 22);
        let (request, _, _) = prepare_finalize_request(
            &mut connection,
            &store,
            now,
            Vec::new(),
            FinalKvChoice::LeaveKv,
        );
        let mut attacks = Vec::new();
        let mut changed = request.clone();
        changed.delivery.authority.plugin_id = PluginId::parse("changed").unwrap();
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.authority.package_generation += 1;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.authority.activation_epoch += 1;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.authority.host_session_id = OperationId::new();
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.authority.invocation_id = OperationId::new();
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.authority.payload_sha256 = Sha256Digest::of(b"changed payload");
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.authority.mode = PluginDeliveryMode::Active;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.persisted_entry_id = PluginId::parse("changed").unwrap();
        attacks.push(changed);
        let mut changed = request.clone();
        changed.delivery.request_sha256 = Sha256Digest::of(b"changed final request");
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.operation_id = OperationId::new();
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.plugin_id = PluginId::parse("changed").unwrap();
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.package_generation += 1;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.activation_epoch += 1;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.expected_cursor.revision += 1;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.snapshot_revision -= 1;
        attacks.push(changed);
        let mut changed = request.clone();
        changed.session.snapshot_event_epoch = OperationId::new().to_string();
        attacks.push(changed);
        for attack in attacks {
            assert_eq!(
                finalize_plugin_resync(&mut connection, attack, now),
                Err(RepositoryError::Conflict)
            );
            assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 1);
        }
        connection
            .execute(
                "UPDATE plugin_invocations SET request_hash = ?2 WHERE operation_id = ?1",
                params![
                    request.session.operation_id.to_string(),
                    Sha256Digest::of(b"changed durable request").as_str()
                ],
            )
            .unwrap();
        assert_eq!(
            finalize_plugin_resync(&mut connection, request.clone(), now),
            Err(RepositoryError::Conflict)
        );
        connection
            .execute(
                "UPDATE plugin_invocations SET request_hash = ?2 WHERE operation_id = ?1",
                params![
                    request.session.operation_id.to_string(),
                    request.delivery.request_sha256.as_str()
                ],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_invocations SET state = 'reserved' WHERE operation_id = ?1",
                [request.session.operation_id.to_string()],
            )
            .unwrap();
        assert_eq!(
            finalize_plugin_resync(&mut connection, request.clone(), now),
            Err(RepositoryError::Conflict)
        );
        connection
            .execute(
                "UPDATE plugin_invocations SET state = 'effect_committing' WHERE operation_id = ?1",
                [request.session.operation_id.to_string()],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_event_cursors SET revision = revision + 1 WHERE plugin_id = ?1",
                [request.session.plugin_id.as_str()],
            )
            .unwrap();
        assert_eq!(
            finalize_plugin_resync(&mut connection, request.clone(), now),
            Err(RepositoryError::Conflict)
        );
        connection
            .execute(
                "UPDATE plugin_event_cursors SET revision = ?2 WHERE plugin_id = ?1",
                params![
                    request.session.plugin_id.as_str(),
                    as_i64(request.session.expected_cursor.revision, "test cursor").unwrap()
                ],
            )
            .unwrap();
        assert!(matches!(
            finalize_plugin_resync(&mut connection, request, now).unwrap(),
            FinalizePluginResyncOutcome::Committed(_)
        ));
    }

    #[test]
    fn finalize_resync_accepts_complete_retained_represented_and_irrelevant_tail() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_185, 23);
        let (request, plugin, snapshot_revision) = prepare_finalize_request(
            &mut connection,
            &store,
            now,
            Vec::new(),
            FinalKvChoice::LeaveKv,
        );
        set_community_plugin_policy(&mut connection, OperationId::new(), false, now).unwrap();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("Retained tail").unwrap()),
            now,
        )
        .unwrap();
        let head: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(u64::try_from(head).unwrap() > snapshot_revision);
        let classifications: Vec<_> = ((snapshot_revision + 1)..=u64::try_from(head).unwrap())
            .map(|revision| {
                classify_plugin_resync_event(
                    &request.session.snapshot_event_epoch,
                    &load_exact_retained_event(&connection, revision).unwrap(),
                    &plugin.manifest.subscriptions,
                )
                .unwrap()
            })
            .collect();
        assert!(classifications.contains(&PluginResyncEvent::Irrelevant));
        assert!(
            classifications
                .iter()
                .any(|classification| matches!(classification, PluginResyncEvent::Represented(_)))
        );
        let FinalizePluginResyncOutcome::Committed(cursor) =
            finalize_plugin_resync(&mut connection, request, now).unwrap()
        else {
            panic!("complete retained tail unexpectedly restarted resync")
        };
        assert_eq!(cursor.revision, snapshot_revision);
        assert!(!cursor.resync_required);
        assert_eq!(cursor.plugin_id, plugin.plugin_id);
    }

    #[test]
    fn finalize_resync_restarts_on_epoch_retention_invalidating_malformed_and_capacity_tail() {
        #[derive(Clone, Copy)]
        enum Attack {
            Epoch,
            Missing,
            Invalidating,
            Malformed,
            Capacity,
        }
        for attack in [
            Attack::Epoch,
            Attack::Missing,
            Attack::Invalidating,
            Attack::Malformed,
            Attack::Capacity,
        ] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_800_000_185, 24);
            let (request, plugin, snapshot_revision) = prepare_finalize_request(
                &mut connection,
                &store,
                now,
                vec![("new".to_owned(), vec![2])],
                FinalKvChoice::ReplaceKvWithStagedSegments,
            );
            connection
                .execute(
                    "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                     VALUES (?1, 'old', X'01', ?2)",
                    params![plugin.plugin_id.as_str(), now.to_string()],
                )
                .unwrap();
            match attack {
                Attack::Epoch => {
                    connection
                        .execute(
                            "UPDATE app_state SET event_epoch = ?1 WHERE singleton = 1",
                            [OperationId::new().to_string()],
                        )
                        .unwrap();
                }
                Attack::Missing | Attack::Malformed => {
                    task_ops::create_task(
                        &mut connection,
                        OperationId::new(),
                        TaskId::new(),
                        TaskDraft::new(TaskTitle::new("Concurrent event").unwrap()),
                        now,
                    )
                    .unwrap();
                    if matches!(attack, Attack::Missing) {
                        connection
                            .execute(
                                "DELETE FROM events WHERE revision = ?1",
                                [i64::try_from(snapshot_revision + 1).unwrap()],
                            )
                            .unwrap();
                    } else {
                        connection
                            .execute(
                                "UPDATE events SET event_json = '{}' WHERE revision = ?1",
                                [i64::try_from(snapshot_revision + 1).unwrap()],
                            )
                            .unwrap();
                    }
                }
                Attack::Invalidating => {
                    let source = OperationId::new();
                    task_ops::create_task(
                        &mut connection,
                        source,
                        TaskId::new(),
                        TaskDraft::new(TaskTitle::new("Concurrent undo").unwrap()),
                        now,
                    )
                    .unwrap();
                    crate::undo_ops::undo(&mut connection, source, OperationId::new(), now)
                        .unwrap();
                }
                Attack::Capacity => {
                    connection
                        .execute(
                            "UPDATE app_state SET global_revision = ?1 WHERE singleton = 1",
                            [i64::try_from(
                                snapshot_revision
                                    + u64::try_from(EVENT_RETAIN_MAX_COUNT).unwrap()
                                    + 1,
                            )
                            .unwrap()],
                        )
                        .unwrap();
                }
            }
            let expected_revision = request.session.expected_cursor.revision;
            assert_eq!(
                finalize_plugin_resync(&mut connection, request, now).unwrap(),
                FinalizePluginResyncOutcome::RestartRequired
            );
            let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
            assert!(cursor.resync_required);
            assert_eq!(cursor.revision, expected_revision);
            assert!(list_plugin_invocations(&connection).unwrap().is_empty());
            let kv = list_plugin_kv(&connection, plugin.plugin_id.clone()).unwrap();
            assert_eq!(kv.len(), 1);
            assert_eq!(kv[0].key, "old");
            if matches!(attack, Attack::Invalidating) {
                let fresh_plugin =
                    get_installed_plugin(&connection, plugin.plugin_id.clone()).unwrap();
                let (fresh, _, fresh_revision) = prepare_finalize_for_plugin(
                    &mut connection,
                    fresh_plugin,
                    now,
                    Vec::new(),
                    FinalKvChoice::LeaveKv,
                );
                let FinalizePluginResyncOutcome::Committed(cursor) =
                    finalize_plugin_resync(&mut connection, fresh, now).unwrap()
                else {
                    panic!("fresh resync did not commit after invalidating restart")
                };
                assert_eq!(cursor.revision, fresh_revision);
                assert!(!cursor.resync_required);
            }
        }
    }

    #[test]
    fn resync_invocation_binds_identity_and_atomically_finalizes_kv_and_cursor() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_185, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Storage], now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            granted.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let plugin = get_installed_plugin(&connection, granted.plugin_id).unwrap();
        assert_eq!(plugin.runtime_state, PluginRuntimeState::Starting);
        let cursor = get_plugin_cursor(&connection, plugin.plugin_id.clone()).unwrap();
        connection
            .execute(
                "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                 VALUES (?1, 'old-key', X'09', ?2)",
                params![plugin.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        let head: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            advance_cursor_for_test(
                &mut connection,
                AdvancePluginCursorRequest {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected: PluginCursorPosition::from(&cursor),
                    next: PluginCursorPosition {
                        event_epoch: cursor.event_epoch.clone(),
                        revision: head as u64,
                        resync_required: false,
                    },
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let operation_id = OperationId::new();
        let session = open_plugin_resync_session(
            &mut connection,
            BeginPluginResyncRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
            },
            now,
        )
        .unwrap();
        assert_eq!(session.snapshot_revision, head as u64);
        let reservation = ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::Resync,
            entry: PluginManifestEntry::Resync,
            request_sha256: plugin_resync_request_hash(&session),
            delivery_operation_id: OperationId::new(),
            resync_session: Some(session.clone()),
        };
        reserve_invocation_for_test(&mut connection, reservation.clone(), now).unwrap();
        let mut changed = reservation;
        changed.delivery_operation_id = OperationId::new();
        assert_eq!(
            reserve_invocation_for_test(&mut connection, changed, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        // A fixed-head resync may finalize after newer retained events arrive; catch-up
        // consumes that retained tail before live admission reopens.
        set_community_plugin_policy(&mut connection, OperationId::new(), false, now).unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            },
            now,
        )
        .unwrap();
        let committed = commit_invocation_for_test(
            &mut connection,
            plan(CommitPluginInvocationRequest {
                invocation_operation_id: operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                child_operation_id: None,
                domain_effect: None,
                kv_patch: None,
                resync_kv: Some(PluginResyncKvCommit::Replace(vec![(
                    "preserved".to_owned(),
                    vec![1, 2, 3],
                )])),
                cursor: Some(AdvancePluginCursorRequest {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected: session.expected_cursor.clone(),
                    next: PluginCursorPosition {
                        event_epoch: session.snapshot_event_epoch.clone(),
                        revision: session.snapshot_revision,
                        resync_required: false,
                    },
                }),
                resync_session: Some(session),
            }),
            now,
        )
        .unwrap();
        assert!(committed.mutation.is_none());
        assert_eq!(committed.cursor.unwrap().revision, head as u64);
        assert!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
                > head
        );
        let replaced_kv = list_plugin_kv(&connection, plugin.plugin_id).unwrap();
        assert_eq!(replaced_kv.len(), 1);
        assert_eq!(replaced_kv[0].key, "preserved");
        assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 0);
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            head + 1
        );
    }

    #[test]
    fn authorized_delivery_is_recomputed_at_reserve_transition_complete_commit_and_replay() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_188, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Commands], now);
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let entry = PluginManifestEntry::Command {
            command_id: PluginId::parse("run").unwrap(),
        };

        let operation_id = OperationId::new();
        let authorized = authorized_reservation(
            &plugin,
            operation_id,
            PluginHookKind::InvokeCommand,
            entry.clone(),
            PluginDeliveryMode::Active,
            Sha256Digest::of(b"command-body"),
            None,
        );
        let mut changed_reserve = authorized.clone();
        changed_reserve.delivery.authority.host_session_id = OperationId::new();
        assert_eq!(
            reserve_authorized_plugin_invocation(&mut connection, changed_reserve, now)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        reserve_authorized_plugin_invocation(&mut connection, authorized.clone(), now).unwrap();

        let transition = TransitionPluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            expected_state: PluginInvocationState::Reserved,
            next_state: PluginInvocationState::EffectCommitting,
        };
        let mut changed_delivery = authorized.delivery.clone();
        changed_delivery.authority.payload_sha256 = Sha256Digest::of(b"changed");
        assert_eq!(
            transition_authorized_plugin_invocation(
                &mut connection,
                AuthorizedTransitionPluginInvocationRequest {
                    request: transition.clone(),
                    delivery: changed_delivery.clone(),
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        transition_authorized_plugin_invocation(
            &mut connection,
            AuthorizedTransitionPluginInvocationRequest {
                request: transition,
                delivery: authorized.delivery.clone(),
            },
            now,
        )
        .unwrap();

        let planned = |delivery| {
            junban_app::plan_authorized_plugin_invocation_commit(
                junban_app::AuthorizedCommitPluginInvocationRequest {
                    request: junban_app::CommitPluginInvocationRequest {
                        invocation_operation_id: operation_id,
                        plugin_id: plugin.plugin_id.clone(),
                        package_generation: plugin.package_generation,
                        activation_epoch: plugin.activation_epoch,
                        child_operation_id: None,
                        domain_effect: None,
                        kv_patch: None,
                        resync_kv: None,
                        cursor: None,
                        resync_session: None,
                    },
                    delivery,
                },
            )
            .unwrap()
        };
        assert_eq!(
            commit_authorized_plugin_invocation(&mut connection, planned(changed_delivery), now,)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        let committed = commit_authorized_plugin_invocation(
            &mut connection,
            planned(authorized.delivery.clone()),
            now,
        )
        .unwrap();
        assert_eq!(
            committed.terminal_kind,
            PluginInvocationTerminalKind::ReadOnly
        );

        let completion_operation = OperationId::new();
        let completion = authorized_reservation(
            &plugin,
            completion_operation,
            PluginHookKind::InvokeCommand,
            entry,
            PluginDeliveryMode::Active,
            Sha256Digest::of(b"completion-body"),
            None,
        );
        reserve_authorized_plugin_invocation(&mut connection, completion.clone(), now).unwrap();
        let mut changed_completion = completion.delivery.clone();
        changed_completion.request_sha256 = Sha256Digest::of(b"changed");
        assert_eq!(
            complete_authorized_plugin_invocation(
                &mut connection,
                CompletePluginInvocationRequest {
                    operation_id: completion_operation,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    delivery: changed_completion,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        complete_authorized_plugin_invocation(
            &mut connection,
            CompletePluginInvocationRequest {
                operation_id: completion_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                delivery: completion.delivery.clone(),
            },
            now,
        )
        .unwrap();
        assert!(matches!(
            reserve_authorized_plugin_invocation(&mut connection, completion.clone(), now).unwrap(),
            ReservedPluginInvocation::TerminalReplay(_)
        ));
        let mut changed_replay = completion;
        changed_replay.delivery.authority.host_session_id = OperationId::new();
        assert_eq!(
            reserve_authorized_plugin_invocation(&mut connection, changed_replay, now).unwrap_err(),
            RepositoryError::Conflict
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn completed_operator_replays_by_stable_identity_across_host_rotation() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_188, 20);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Commands], now);
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let operation_id = OperationId::new();
        let entry_id = PluginId::parse("run").unwrap();
        let private_body = serde_json::to_vec(&InvocationRequest::invoke_command(
            Some(entry_id.to_string()),
            CommandCall {
                command_id: entry_id.to_string(),
                values: Vec::new(),
            },
        ))
        .unwrap();
        let identity = junban_app::PluginOperatorRequestIdentity::from_canonical_private_body(
            operation_id,
            plugin.plugin_id.clone(),
            PluginHookKind::InvokeCommand,
            entry_id.clone(),
            entry_id.as_str(),
            &private_body,
        )
        .unwrap();
        let authorized = authorized_reservation(
            &plugin,
            operation_id,
            PluginHookKind::InvokeCommand,
            PluginManifestEntry::Command {
                command_id: entry_id.clone(),
            },
            PluginDeliveryMode::Active,
            identity.payload_sha256.clone(),
            None,
        );
        let first_host_session = authorized.delivery.authority.host_session_id;
        reserve_authorized_plugin_invocation(&mut connection, authorized.clone(), now).unwrap();
        let committed = complete_authorized_plugin_invocation(
            &mut connection,
            CompletePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                delivery: authorized.delivery.clone(),
            },
            now,
        )
        .unwrap();

        let replay = replay_completed_plugin_operator(&mut connection, identity.clone(), now)
            .unwrap()
            .unwrap();
        assert!(replay.replayed);
        assert_eq!(
            serde_json::to_string(&replay).unwrap(),
            serde_json::to_string(&committed).unwrap()
        );

        let rotated_delivery = PluginInvocationDelivery::new(
            junban_app::PluginDeliveryAuthority {
                host_session_id: OperationId::new(),
                ..authorized.delivery.authority.clone()
            },
            PluginHookKind::InvokeCommand,
            entry_id.clone(),
        )
        .unwrap();
        assert_ne!(
            rotated_delivery.authority.host_session_id,
            first_host_session
        );
        let mut rotated = authorized.clone();
        rotated.request.request_sha256 = rotated_delivery.request_sha256.clone();
        rotated.delivery = rotated_delivery;
        assert_eq!(
            reserve_authorized_plugin_invocation(&mut connection, rotated, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        assert!(
            replay_completed_plugin_operator(&mut connection, identity.clone(), now)
                .unwrap()
                .is_some()
        );

        let mut changed_body = identity.clone();
        changed_body.payload_sha256 = Sha256Digest::of(b"changed body");
        let mut changed_entry = identity.clone();
        changed_entry.persisted_entry_id = PluginId::parse("other-command").unwrap();
        let mut changed_hook = identity.clone();
        changed_hook.hook_kind = PluginHookKind::HandleSurfaceAction;
        let mut changed_plugin = identity.clone();
        changed_plugin.plugin_id = PluginId::parse("other-plugin").unwrap();
        for changed in [changed_body, changed_entry, changed_hook, changed_plugin] {
            assert_eq!(
                replay_completed_plugin_operator(&mut connection, changed, now).unwrap_err(),
                RepositoryError::IdempotencyMismatch
            );
        }
        let absent = junban_app::PluginOperatorRequestIdentity::new(
            OperationId::new(),
            plugin.plugin_id.clone(),
            PluginHookKind::InvokeCommand,
            entry_id.clone(),
            identity.payload_sha256.clone(),
        )
        .unwrap();
        assert!(
            replay_completed_plugin_operator(&mut connection, absent, now)
                .unwrap()
                .is_none()
        );

        let in_flight_operation = OperationId::new();
        let in_flight = authorized_reservation(
            &plugin,
            in_flight_operation,
            PluginHookKind::InvokeCommand,
            PluginManifestEntry::Command {
                command_id: entry_id.clone(),
            },
            PluginDeliveryMode::Active,
            identity.payload_sha256.clone(),
            None,
        );
        reserve_authorized_plugin_invocation(&mut connection, in_flight, now).unwrap();
        let in_flight_identity = junban_app::PluginOperatorRequestIdentity::new(
            in_flight_operation,
            plugin.plugin_id.clone(),
            PluginHookKind::InvokeCommand,
            entry_id.clone(),
            identity.payload_sha256.clone(),
        )
        .unwrap();
        assert!(
            replay_completed_plugin_operator(&mut connection, in_flight_identity.clone(), now)
                .unwrap()
                .is_none()
        );
        connection
            .execute(
                "DELETE FROM plugin_invocations WHERE operation_id = ?1",
                [in_flight_operation.to_string()],
            )
            .unwrap();
        assert!(
            replay_completed_plugin_operator(&mut connection, in_flight_identity, now)
                .unwrap()
                .is_none()
        );
        assert!(
            junban_app::PluginOperatorRequestIdentity::new(
                OperationId::new(),
                plugin.plugin_id,
                PluginHookKind::HandleEvent,
                PluginId::parse("task-created").unwrap(),
                identity.payload_sha256,
            )
            .is_err()
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        drop(backup);
    }

    #[test]
    fn operator_receipt_stable_and_executed_authority_corruption_fails_all_validators() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_700_000_188, 21);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Commands], now);
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let operation_id = OperationId::new();
        let authorized = authorized_reservation(
            &plugin,
            operation_id,
            PluginHookKind::InvokeCommand,
            PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            PluginDeliveryMode::Active,
            Sha256Digest::of(b"receipt authority body"),
            None,
        );
        reserve_authorized_plugin_invocation(&mut connection, authorized.clone(), now).unwrap();
        complete_authorized_plugin_invocation(
            &mut connection,
            CompletePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id,
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                delivery: authorized.delivery,
            },
            now,
        )
        .unwrap();
        let canonical_request: String = connection
            .query_row(
                "SELECT request_json FROM operation_receipts WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        let mut attacks = Vec::new();
        let mut changed_stable: serde_json::Value =
            serde_json::from_str(&canonical_request).unwrap();
        changed_stable["stable"]["payload_sha256"] = serde_json::Value::String("11".repeat(32));
        attacks.push(serde_json::to_string(&changed_stable).unwrap());
        let mut changed_final: serde_json::Value =
            serde_json::from_str(&canonical_request).unwrap();
        changed_final["executed"]["request_sha256"] = serde_json::Value::String("22".repeat(32));
        attacks.push(serde_json::to_string(&changed_final).unwrap());
        for attack in attacks {
            connection
                .execute(
                    "UPDATE operation_receipts SET request_json = ?2 WHERE operation_id = ?1",
                    params![operation_id.to_string(), attack],
                )
                .unwrap();
            assert!(crate::plugin_validation::validate_plugin_authority(&connection).is_err());
            assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
            connection
                .execute(
                    "UPDATE operation_receipts SET request_json = ?2 WHERE operation_id = ?1",
                    params![operation_id.to_string(), canonical_request],
                )
                .unwrap();
            crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        }

        let candidate_connection = Connection::open(candidate.path()).unwrap();
        candidate_connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2 WHERE operation_id = ?1",
                params![operation_id.to_string(), changed_final.to_string()],
            )
            .unwrap();
        drop(candidate_connection);
        assert!(
            crate::backup_ops::restore_backup(&mut connection, &profile.path, candidate).is_err()
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn starting_resync_binds_session_payload_inside_final_request_hash() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_187, 0);
        let installed = install_fixture(&mut connection, &store, now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let plugin = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        let operation_id = OperationId::new();
        let session = open_plugin_resync_session(
            &mut connection,
            BeginPluginResyncRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
            },
            now,
        )
        .unwrap();
        let authorized = authorized_reservation(
            &plugin,
            operation_id,
            PluginHookKind::Resync,
            PluginManifestEntry::Resync,
            PluginDeliveryMode::StartingResync,
            plugin_resync_request_hash(&session),
            Some(session),
        );
        assert_ne!(
            authorized.request.request_sha256,
            authorized.delivery.authority.payload_sha256
        );
        let reserved =
            reserve_authorized_plugin_invocation(&mut connection, authorized, now).unwrap();
        assert!(matches!(reserved, ReservedPluginInvocation::Reserved(_)));
    }

    #[test]
    fn starting_catch_up_delivery_rejects_active_and_http_authority() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_189, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let expected_cursor = load_plugin_cursor(&connection, &plugin.plugin_id).unwrap();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("Catch-up event").unwrap()),
            now,
        )
        .unwrap();
        let head_revision = u64::try_from(
            connection
                .query_row(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(head_revision, expected_cursor.revision + 1);
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                [plugin.plugin_id.as_str()],
            )
            .unwrap();
        let plugin = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        let active = authorized_retained_event_reservation(
            &connection,
            &plugin,
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        assert_eq!(
            reserve_authorized_plugin_invocation(&mut connection, active, now).unwrap_err(),
            RepositoryError::Conflict
        );

        let operation_id = OperationId::new();
        let catch_up = authorized_retained_event_reservation(
            &connection,
            &plugin,
            operation_id,
            PluginDeliveryMode::StartingCatchUp,
        );
        let source = catch_up.delivery.retained_event_source().unwrap();
        let catch_up_cursor = AdvancePluginCursorRequest {
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            expected: source.expected_cursor.clone(),
            next: source.next_cursor.clone(),
        };
        reserve_authorized_plugin_invocation(&mut connection, catch_up.clone(), now).unwrap();
        assert_eq!(
            transition_authorized_plugin_invocation(
                &mut connection,
                AuthorizedTransitionPluginInvocationRequest {
                    request: TransitionPluginInvocationRequest {
                        operation_id,
                        plugin_id: plugin.plugin_id.clone(),
                        package_generation: plugin.package_generation,
                        activation_epoch: plugin.activation_epoch,
                        expected_state: PluginInvocationState::Reserved,
                        next_state: PluginInvocationState::DispatchingHttp,
                    },
                    delivery: catch_up.delivery.clone(),
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        transition_authorized_plugin_invocation(
            &mut connection,
            AuthorizedTransitionPluginInvocationRequest {
                request: TransitionPluginInvocationRequest {
                    operation_id,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected_state: PluginInvocationState::Reserved,
                    next_state: PluginInvocationState::EffectCommitting,
                },
                delivery: catch_up.delivery.clone(),
            },
            now,
        )
        .unwrap();
        assert_eq!(
            complete_authorized_plugin_invocation(
                &mut connection,
                CompletePluginInvocationRequest {
                    operation_id,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    delivery: catch_up.delivery.clone(),
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let planned = junban_app::plan_authorized_plugin_invocation_commit(
            junban_app::AuthorizedCommitPluginInvocationRequest {
                request: junban_app::CommitPluginInvocationRequest {
                    invocation_operation_id: operation_id,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    child_operation_id: None,
                    domain_effect: None,
                    kv_patch: None,
                    resync_kv: None,
                    cursor: None,
                    resync_session: None,
                },
                delivery: catch_up.delivery.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            commit_authorized_plugin_invocation(&mut connection, planned, now).unwrap_err(),
            RepositoryError::Conflict
        );
        let planned = junban_app::plan_authorized_plugin_invocation_commit(
            junban_app::AuthorizedCommitPluginInvocationRequest {
                request: junban_app::CommitPluginInvocationRequest {
                    invocation_operation_id: operation_id,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    child_operation_id: None,
                    domain_effect: None,
                    kv_patch: None,
                    resync_kv: None,
                    cursor: Some(catch_up_cursor),
                    resync_session: None,
                },
                delivery: catch_up.delivery,
            },
        )
        .unwrap();
        commit_authorized_plugin_invocation(&mut connection, planned, now).unwrap();
        complete_plugin_activation(
            &mut connection,
            OperationId::new(),
            CompletePluginActivationRequest {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
            },
            now,
        )
        .unwrap();
        let active_plugin = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        assert_eq!(active_plugin.runtime_state, PluginRuntimeState::Active);
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("Live event").unwrap()),
            now,
        )
        .unwrap();
        let live_event = authorized_retained_event_reservation(
            &connection,
            &active_plugin,
            OperationId::new(),
            PluginDeliveryMode::Active,
        );
        assert!(matches!(
            reserve_authorized_plugin_invocation(&mut connection, live_event, now).unwrap(),
            ReservedPluginInvocation::Reserved(_)
        ));
    }

    #[test]
    fn retained_event_source_is_revalidated_at_every_stage_and_cannot_jump_to_head() {
        for mode in [
            PluginDeliveryMode::StartingCatchUp,
            PluginDeliveryMode::Active,
        ] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_800_000_189, mode as i32);
            let installed = install_fixture(&mut connection, &store, now);
            let granted = grant_capabilities(
                &mut connection,
                &installed,
                &[Capability::EventsSubscribe],
                now,
            );
            let active = activate_plugin(&mut connection, &store, &granted, now);
            if mode == PluginDeliveryMode::StartingCatchUp {
                connection
                    .execute(
                        "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                        [active.plugin_id.as_str()],
                    )
                    .unwrap();
            }
            let plugin = get_installed_plugin(&connection, active.plugin_id).unwrap();
            task_ops::create_task(
                &mut connection,
                OperationId::new(),
                TaskId::new(),
                TaskDraft::new(TaskTitle::new("Exact source").unwrap()),
                now,
            )
            .unwrap();
            let operation_id = OperationId::new();
            let authorized =
                authorized_retained_event_reservation(&connection, &plugin, operation_id, mode);

            for changed in mutated_event_deliveries(&authorized.delivery) {
                let mut request = authorized.clone();
                request.delivery = changed;
                assert_eq!(
                    reserve_authorized_plugin_invocation(&mut connection, request, now)
                        .unwrap_err(),
                    RepositoryError::Conflict
                );
            }
            reserve_authorized_plugin_invocation(&mut connection, authorized.clone(), now).unwrap();

            let transition = TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::EffectCommitting,
            };
            for changed in mutated_event_deliveries(&authorized.delivery) {
                assert_eq!(
                    transition_authorized_plugin_invocation(
                        &mut connection,
                        AuthorizedTransitionPluginInvocationRequest {
                            request: transition.clone(),
                            delivery: changed,
                        },
                        now,
                    )
                    .unwrap_err(),
                    RepositoryError::Conflict
                );
            }
            transition_authorized_plugin_invocation(
                &mut connection,
                AuthorizedTransitionPluginInvocationRequest {
                    request: transition,
                    delivery: authorized.delivery.clone(),
                },
                now,
            )
            .unwrap();

            task_ops::create_task(
                &mut connection,
                OperationId::new(),
                TaskId::new(),
                TaskDraft::new(TaskTitle::new("Later head").unwrap()),
                now,
            )
            .unwrap();
            let head = connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap() as u64;
            let exact_cursor = event_cursor_request(&plugin, &authorized.delivery);
            assert!(head > exact_cursor.next.revision);
            let planned = |delivery, cursor| {
                junban_app::plan_authorized_plugin_invocation_commit(
                    junban_app::AuthorizedCommitPluginInvocationRequest {
                        request: CommitPluginInvocationRequest {
                            invocation_operation_id: operation_id,
                            plugin_id: plugin.plugin_id.clone(),
                            package_generation: plugin.package_generation,
                            activation_epoch: plugin.activation_epoch,
                            child_operation_id: None,
                            domain_effect: None,
                            kv_patch: None,
                            resync_kv: None,
                            cursor: Some(cursor),
                            resync_session: None,
                        },
                        delivery,
                    },
                )
                .unwrap()
            };
            for changed in mutated_event_deliveries(&authorized.delivery) {
                assert_eq!(
                    commit_authorized_plugin_invocation(
                        &mut connection,
                        planned(changed, exact_cursor.clone()),
                        now,
                    )
                    .unwrap_err(),
                    RepositoryError::Conflict
                );
            }

            let mut jump_to_head = exact_cursor.clone();
            jump_to_head.next.revision = head;
            assert_eq!(
                commit_authorized_plugin_invocation(
                    &mut connection,
                    planned(authorized.delivery.clone(), jump_to_head),
                    now,
                )
                .unwrap_err(),
                RepositoryError::Conflict
            );
            let committed = commit_authorized_plugin_invocation(
                &mut connection,
                planned(authorized.delivery, exact_cursor.clone()),
                now,
            )
            .unwrap();
            assert_eq!(
                committed.cursor.unwrap().revision,
                exact_cursor.next.revision
            );
        }
    }

    #[test]
    fn verified_cursor_skip_accepts_only_one_exact_irrelevant_event_without_live_work() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_189, 10);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::EventsSubscribe],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        append_irrelevant_settings_event(&mut connection, now, "#123456");
        let skip = verified_skip_request(
            &connection,
            &plugin,
            PluginDeliveryMode::Active,
            PluginRetainedEventClassification::Irrelevant,
        );
        for classification in [
            PluginRetainedEventClassification::Represented,
            PluginRetainedEventClassification::Invalidating,
        ] {
            let mut changed = skip.clone();
            changed.classification = classification;
            assert_eq!(
                verified_skip_plugin_cursor(&mut connection, changed, now).unwrap_err(),
                RepositoryError::Conflict
            );
        }
        let skipped = verified_skip_plugin_cursor(&mut connection, skip.clone(), now).unwrap();
        assert_eq!(skipped.revision, skip.next_cursor.revision);
        assert_eq!(
            verified_skip_plugin_cursor(&mut connection, skip, now).unwrap_err(),
            RepositoryError::Conflict
        );

        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("Subscribed skip rejection").unwrap()),
            now,
        )
        .unwrap();
        let subscribed = verified_skip_request(
            &connection,
            &plugin,
            PluginDeliveryMode::Active,
            PluginRetainedEventClassification::Irrelevant,
        );
        assert_eq!(
            verified_skip_plugin_cursor(&mut connection, subscribed, now).unwrap_err(),
            RepositoryError::Conflict
        );

        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Commands], now);
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        append_irrelevant_settings_event(&mut connection, now, "#234567");
        let blocked_skip = verified_skip_request(
            &connection,
            &plugin,
            PluginDeliveryMode::Active,
            PluginRetainedEventClassification::Irrelevant,
        );
        let operator = ReservePluginInvocationRequest {
            operation_id: OperationId::new(),
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(b"live skip blocker"),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        reserve_invocation_for_test(&mut connection, operator.clone(), now).unwrap();
        assert_eq!(
            verified_skip_plugin_cursor(&mut connection, blocked_skip.clone(), now).unwrap_err(),
            RepositoryError::Conflict
        );
        terminalize_invocation_for_test(
            &mut connection,
            operator.operation_id,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            now,
        )
        .unwrap();
        verified_skip_plugin_cursor(&mut connection, blocked_skip, now).unwrap();

        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                [plugin.plugin_id.as_str()],
            )
            .unwrap();
        let starting = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        append_irrelevant_settings_event(&mut connection, now, "#345678");
        append_irrelevant_settings_event(&mut connection, now, "#456789");
        let first = verified_skip_request(
            &connection,
            &starting,
            PluginDeliveryMode::StartingCatchUp,
            PluginRetainedEventClassification::Irrelevant,
        );
        let second_revision = first.source_revision + 1;
        let second_event = load_exact_retained_event(&connection, second_revision).unwrap();
        let mut jump = first.clone();
        jump.source_revision = second_revision;
        jump.event_content_sha256 = plugin_committed_event_content_hash(&second_event).unwrap();
        jump.next_cursor.revision = second_revision;
        assert_eq!(
            verified_skip_plugin_cursor(&mut connection, jump, now).unwrap_err(),
            RepositoryError::Conflict
        );
        verified_skip_plugin_cursor(&mut connection, first, now).unwrap();
        let second = verified_skip_request(
            &connection,
            &starting,
            PluginDeliveryMode::StartingCatchUp,
            PluginRetainedEventClassification::Irrelevant,
        );
        assert_eq!(second.source_revision, second_revision);
        verified_skip_plugin_cursor(&mut connection, second, now).unwrap();
    }

    #[test]
    fn lifecycle_failure_paths_abandon_starting_mode_non_http_deliveries() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_186, 0);

        let installed =
            install_named_fixture(&mut connection, &store, "attempt-resync", Vec::new(), now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let resync_plugin = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        let resync_operation = OperationId::new();
        let session = open_plugin_resync_session(
            &mut connection,
            BeginPluginResyncRequest {
                operation_id: resync_operation,
                plugin_id: resync_plugin.plugin_id.clone(),
                package_generation: resync_plugin.package_generation,
                activation_epoch: resync_plugin.activation_epoch,
            },
            now,
        )
        .unwrap();
        reserve_authorized_plugin_invocation(
            &mut connection,
            authorized_reservation(
                &resync_plugin,
                resync_operation,
                PluginHookKind::Resync,
                PluginManifestEntry::Resync,
                PluginDeliveryMode::StartingResync,
                plugin_resync_request_hash(&session),
                Some(session),
            ),
            now,
        )
        .unwrap();
        record_plugin_attempt_failure(
            &mut connection,
            OperationId::new(),
            RecordPluginAttemptFailureRequest {
                plugin_id: resync_plugin.plugin_id,
                package_generation: resync_plugin.package_generation,
                activation_epoch: resync_plugin.activation_epoch,
                cause: junban_app::PluginAttemptFailureCause::GuestTrap,
            },
            now,
        )
        .unwrap();
        assert!(matches!(
            load_invocation(&connection, resync_operation),
            Err(RepositoryError::NotFound)
        ));

        let installed =
            install_named_fixture(&mut connection, &store, "fence-catch-up", Vec::new(), now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe],
            now,
        );
        let active = activate_plugin(&mut connection, &store, &granted, now);
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                [active.plugin_id.as_str()],
            )
            .unwrap();
        let catch_up_plugin = get_installed_plugin(&connection, active.plugin_id).unwrap();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("Failure catch-up").unwrap()),
            now,
        )
        .unwrap();
        let catch_up_operation = OperationId::new();
        let reservation = authorized_retained_event_reservation(
            &connection,
            &catch_up_plugin,
            catch_up_operation,
            PluginDeliveryMode::StartingCatchUp,
        );
        reserve_authorized_plugin_invocation(&mut connection, reservation.clone(), now).unwrap();
        transition_authorized_plugin_invocation(
            &mut connection,
            AuthorizedTransitionPluginInvocationRequest {
                request: TransitionPluginInvocationRequest {
                    operation_id: catch_up_operation,
                    plugin_id: catch_up_plugin.plugin_id.clone(),
                    package_generation: catch_up_plugin.package_generation,
                    activation_epoch: catch_up_plugin.activation_epoch,
                    expected_state: PluginInvocationState::Reserved,
                    next_state: PluginInvocationState::EffectCommitting,
                },
                delivery: reservation.delivery,
            },
            now,
        )
        .unwrap();
        fence_plugin_graph(
            &mut connection,
            PluginGraphFenceRequest {
                operation_id: OperationId::new(),
                host_session_id: OperationId::new().to_string(),
                entries: vec![junban_app::PluginGraphFenceEntry {
                    plugin_id: catch_up_plugin.plugin_id,
                    package_generation: catch_up_plugin.package_generation,
                    activation_epoch: catch_up_plugin.activation_epoch,
                    cause: PluginGraphFenceCause::ChildFatal,
                    disposition: PluginGraphFenceDisposition::Failing,
                }],
            },
            now,
        )
        .unwrap();
        assert!(matches!(
            load_invocation(&connection, catch_up_operation),
            Err(RepositoryError::NotFound)
        ));
    }

    #[tokio::test]
    async fn normal_open_abandons_every_non_http_mode_and_preserves_only_http_ambiguity() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_190, 0);

        let installed =
            install_named_fixture(&mut connection, &store, "active-reserved", Vec::new(), now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Commands], now);
        let active_reserved = activate_plugin(&mut connection, &store, &granted, now);
        let active_reserved_operation = OperationId::new();
        reserve_authorized_plugin_invocation(
            &mut connection,
            authorized_reservation(
                &active_reserved,
                active_reserved_operation,
                PluginHookKind::InvokeCommand,
                PluginManifestEntry::Command {
                    command_id: PluginId::parse("run").unwrap(),
                },
                PluginDeliveryMode::Active,
                Sha256Digest::of(b"active-reserved"),
                None,
            ),
            now,
        )
        .unwrap();

        let installed =
            install_named_fixture(&mut connection, &store, "active-http", Vec::new(), now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let active_http = activate_plugin(&mut connection, &store, &granted, now);
        let active_http_operation = OperationId::new();
        let active_http_reservation = authorized_reservation(
            &active_http,
            active_http_operation,
            PluginHookKind::InvokeCommand,
            PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            PluginDeliveryMode::Active,
            Sha256Digest::of(b"active-http"),
            None,
        );
        reserve_authorized_plugin_invocation(&mut connection, active_http_reservation.clone(), now)
            .unwrap();
        transition_authorized_plugin_invocation(
            &mut connection,
            AuthorizedTransitionPluginInvocationRequest {
                request: TransitionPluginInvocationRequest {
                    operation_id: active_http_operation,
                    plugin_id: active_http.plugin_id.clone(),
                    package_generation: active_http.package_generation,
                    activation_epoch: active_http.activation_epoch,
                    expected_state: PluginInvocationState::Reserved,
                    next_state: PluginInvocationState::DispatchingHttp,
                },
                delivery: active_http_reservation.delivery,
            },
            now,
        )
        .unwrap();

        let installed = install_named_fixture(
            &mut connection,
            &store,
            "starting-catch-up",
            Vec::new(),
            now,
        );
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::EventsSubscribe],
            now,
        );
        let active = activate_plugin(&mut connection, &store, &granted, now);
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                [active.plugin_id.as_str()],
            )
            .unwrap();
        let starting_catch_up = get_installed_plugin(&connection, active.plugin_id).unwrap();
        task_ops::create_task(
            &mut connection,
            OperationId::new(),
            TaskId::new(),
            TaskDraft::new(TaskTitle::new("Restart catch-up").unwrap()),
            now,
        )
        .unwrap();
        let catch_up_operation = OperationId::new();
        let catch_up_reservation = authorized_retained_event_reservation(
            &connection,
            &starting_catch_up,
            catch_up_operation,
            PluginDeliveryMode::StartingCatchUp,
        );
        reserve_authorized_plugin_invocation(&mut connection, catch_up_reservation.clone(), now)
            .unwrap();
        transition_authorized_plugin_invocation(
            &mut connection,
            AuthorizedTransitionPluginInvocationRequest {
                request: TransitionPluginInvocationRequest {
                    operation_id: catch_up_operation,
                    plugin_id: starting_catch_up.plugin_id.clone(),
                    package_generation: starting_catch_up.package_generation,
                    activation_epoch: starting_catch_up.activation_epoch,
                    expected_state: PluginInvocationState::Reserved,
                    next_state: PluginInvocationState::EffectCommitting,
                },
                delivery: catch_up_reservation.delivery,
            },
            now,
        )
        .unwrap();

        let installed =
            install_named_fixture(&mut connection, &store, "starting-resync", Vec::new(), now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let starting_resync = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        let resync_operation = OperationId::new();
        let session = open_plugin_resync_session(
            &mut connection,
            BeginPluginResyncRequest {
                operation_id: resync_operation,
                plugin_id: starting_resync.plugin_id.clone(),
                package_generation: starting_resync.package_generation,
                activation_epoch: starting_resync.activation_epoch,
            },
            now,
        )
        .unwrap();
        reserve_authorized_plugin_invocation(
            &mut connection,
            authorized_reservation(
                &starting_resync,
                resync_operation,
                PluginHookKind::Resync,
                PluginManifestEntry::Resync,
                PluginDeliveryMode::StartingResync,
                plugin_resync_request_hash(&session),
                Some(session),
            ),
            now,
        )
        .unwrap();
        assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 4);
        drop(connection);
        drop(store);

        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let invocations = owner.repository().list_plugin_invocations().await.unwrap();
        assert_eq!(invocations.len(), 1);
        assert_eq!(invocations[0].operation_id, active_http_operation);
        assert_eq!(invocations[0].state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(invocations[0].error_code.as_deref(), Some("http_ambiguous"));
    }

    #[test]
    fn restart_reconciliation_keeps_only_http_ambiguity() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_190, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let reserve = |operation_id| ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(operation_id.to_string().as_bytes()),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        let http_operation = OperationId::new();
        reserve_invocation_for_test(&mut connection, reserve(http_operation), now).unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        reconcile_packages(&mut connection, &store, now).unwrap();
        let ambiguous = load_invocation(&connection, http_operation).unwrap();
        assert_eq!(ambiguous.state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(ambiguous.error_code.as_deref(), Some("http_ambiguous"));
        let starting = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        complete_plugin_activation(
            &mut connection,
            OperationId::new(),
            CompletePluginActivationRequest {
                plugin_id: starting.plugin_id.clone(),
                package_generation: starting.package_generation,
                activation_epoch: starting.activation_epoch,
            },
            now,
        )
        .unwrap();
        let active = get_installed_plugin(&connection, starting.plugin_id).unwrap();
        let retry = transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: active.plugin_id,
                package_generation: active.package_generation,
                activation_epoch: active.activation_epoch,
                expected_state: PluginInvocationState::AmbiguousHttp,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        assert_eq!(retry.state, PluginInvocationState::DispatchingHttp);
        assert_eq!(retry.error_code, None);
        terminalize_invocation_for_test(
            &mut connection,
            http_operation,
            retry.plugin_id,
            retry.package_generation,
            retry.activation_epoch,
            now,
        )
        .unwrap();
        assert!(list_plugin_invocations(&connection).unwrap().is_empty());
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 1
        );
    }

    #[test]
    fn due_retry_requires_active_epoch_before_ambiguous_http_redispatch() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_192, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let operation_id = OperationId::new();
        let delivery_operation_id = OperationId::new();
        let reservation = ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(b"host-failure-http"),
            delivery_operation_id,
            resync_session: None,
        };
        reserve_invocation_for_test(&mut connection, reservation.clone(), now).unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        let outcome = fence_plugin_graph(
            &mut connection,
            PluginGraphFenceRequest {
                operation_id: OperationId::new(),
                host_session_id: OperationId::new().to_string(),
                entries: vec![PluginGraphFenceEntry {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    cause: PluginGraphFenceCause::CompileLoad,
                    disposition: PluginGraphFenceDisposition::Failing,
                }],
            },
            now,
        )
        .unwrap();
        assert_eq!(outcome.results.len(), 1);
        let degraded = get_installed_plugin(&connection, plugin.plugin_id.clone()).unwrap();
        let retry_at = degraded.next_retry_at.unwrap();
        assert_eq!(degraded.activation_epoch, plugin.activation_epoch + 1);
        assert_eq!(degraded.runtime_state, PluginRuntimeState::Degraded);
        assert_eq!(degraded.last_error_code.as_deref(), Some("compile_load"));
        let ambiguous = load_invocation(&connection, operation_id).unwrap();
        assert_eq!(ambiguous.state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(ambiguous.activation_epoch, degraded.activation_epoch);
        assert_eq!(ambiguous.delivery_operation_id, delivery_operation_id);
        assert_eq!(ambiguous.error_code.as_deref(), Some("http_ambiguous"));
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let mut due_reservation = reservation.clone();
        due_reservation.operation_id = OperationId::new();
        due_reservation.activation_epoch = degraded.activation_epoch;
        assert_eq!(
            reserve_invocation_for_test(&mut connection, due_reservation, retry_at).unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            transition_invocation_for_test(
                &mut connection,
                TransitionPluginInvocationRequest {
                    operation_id,
                    plugin_id: degraded.plugin_id.clone(),
                    package_generation: degraded.package_generation,
                    activation_epoch: degraded.activation_epoch,
                    expected_state: PluginInvocationState::AmbiguousHttp,
                    next_state: PluginInvocationState::DispatchingHttp,
                },
                retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );

        connection
            .execute(
                "UPDATE plugin_invocations
                 SET state = 'reserved', error_code = NULL, updated_at = ?2
                 WHERE operation_id = ?1",
                params![operation_id.to_string(), retry_at.to_string()],
            )
            .unwrap();
        for next_state in [
            PluginInvocationState::DispatchingHttp,
            PluginInvocationState::EffectCommitting,
        ] {
            assert_eq!(
                transition_invocation_for_test(
                    &mut connection,
                    TransitionPluginInvocationRequest {
                        operation_id,
                        plugin_id: degraded.plugin_id.clone(),
                        package_generation: degraded.package_generation,
                        activation_epoch: degraded.activation_epoch,
                        expected_state: PluginInvocationState::Reserved,
                        next_state,
                    },
                    retry_at,
                )
                .unwrap_err(),
                RepositoryError::Conflict
            );
        }
        assert_eq!(
            terminalize_invocation_for_test(
                &mut connection,
                operation_id,
                degraded.plugin_id.clone(),
                degraded.package_generation,
                degraded.activation_epoch,
                retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        assert!(crate::plugin_validation::validate_plugin_authority(&connection).is_err());
        connection
            .execute(
                "UPDATE plugin_invocations
                 SET state = 'ambiguous_http', error_code = 'http_ambiguous'
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
            )
            .unwrap();

        let starting = retry_due(&mut connection, &degraded, retry_at).unwrap();
        assert_eq!(starting.runtime_state, PluginRuntimeState::Starting);
        assert_eq!(starting.activation_epoch, degraded.activation_epoch + 1);
        assert_eq!(starting.failure_count, degraded.failure_count);
        let advanced = load_invocation(&connection, operation_id).unwrap();
        assert_eq!(advanced.state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(advanced.activation_epoch, starting.activation_epoch);
        assert_eq!(advanced.delivery_operation_id, delivery_operation_id);
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        for activation_epoch in [degraded.activation_epoch, starting.activation_epoch] {
            assert_eq!(
                transition_invocation_for_test(
                    &mut connection,
                    TransitionPluginInvocationRequest {
                        operation_id,
                        plugin_id: starting.plugin_id.clone(),
                        package_generation: starting.package_generation,
                        activation_epoch,
                        expected_state: PluginInvocationState::AmbiguousHttp,
                        next_state: PluginInvocationState::DispatchingHttp,
                    },
                    retry_at,
                )
                .unwrap_err(),
                RepositoryError::Conflict
            );
        }
        connection
            .execute(
                "UPDATE plugin_invocations
                 SET state = 'dispatching_http', error_code = NULL
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
            )
            .unwrap();
        assert_eq!(
            terminalize_invocation_for_test(
                &mut connection,
                operation_id,
                starting.plugin_id.clone(),
                starting.package_generation,
                starting.activation_epoch,
                retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            commit_invocation_for_test(
                &mut connection,
                plan(CommitPluginInvocationRequest {
                    invocation_operation_id: operation_id,
                    plugin_id: starting.plugin_id.clone(),
                    package_generation: starting.package_generation,
                    activation_epoch: starting.activation_epoch,
                    child_operation_id: None,
                    domain_effect: None,
                    kv_patch: None,
                    resync_kv: None,
                    cursor: None,
                    resync_session: None,
                }),
                retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        assert!(crate::plugin_validation::validate_plugin_authority(&connection).is_err());
        connection
            .execute(
                "UPDATE plugin_invocations
                 SET state = 'ambiguous_http', error_code = 'http_ambiguous'
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
            )
            .unwrap();

        connection
            .execute(
                "UPDATE plugin_event_cursors
                 SET event_epoch = (SELECT event_epoch FROM app_state WHERE singleton = 1),
                     revision = (SELECT global_revision FROM app_state WHERE singleton = 1),
                     resync_required = 0, updated_at = ?2 WHERE plugin_id = ?1",
                params![starting.plugin_id.as_str(), retry_at.to_string()],
            )
            .unwrap();
        complete_plugin_activation(
            &mut connection,
            OperationId::new(),
            CompletePluginActivationRequest {
                plugin_id: starting.plugin_id.clone(),
                package_generation: starting.package_generation,
                activation_epoch: starting.activation_epoch,
            },
            retry_at,
        )
        .unwrap();
        let active = get_installed_plugin(&connection, starting.plugin_id.clone()).unwrap();
        assert_eq!(active.runtime_state, PluginRuntimeState::Active);
        assert_eq!(active.activation_epoch, starting.activation_epoch);
        assert_eq!(
            transition_invocation_for_test(
                &mut connection,
                TransitionPluginInvocationRequest {
                    operation_id,
                    plugin_id: active.plugin_id.clone(),
                    package_generation: active.package_generation,
                    activation_epoch: degraded.activation_epoch,
                    expected_state: PluginInvocationState::AmbiguousHttp,
                    next_state: PluginInvocationState::DispatchingHttp,
                },
                retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let dispatch = transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: active.plugin_id.clone(),
                package_generation: active.package_generation,
                activation_epoch: active.activation_epoch,
                expected_state: PluginInvocationState::AmbiguousHttp,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            retry_at,
        )
        .unwrap();
        assert_eq!(dispatch.delivery_operation_id, delivery_operation_id);
        let terminal = terminalize_invocation_for_test(
            &mut connection,
            operation_id,
            active.plugin_id.clone(),
            active.package_generation,
            active.activation_epoch,
            retry_at,
        )
        .unwrap();
        assert_eq!(terminal.terminal_kind, PluginInvocationTerminalKind::Http);

        let mut replay_request = reservation.clone();
        replay_request.activation_epoch = active.activation_epoch;
        let replay = reserve_invocation_for_test(&mut connection, replay_request, retry_at)
            .unwrap()
            .terminal()
            .unwrap()
            .clone();
        assert!(replay.replayed);
        assert_eq!(replay.terminal_kind, PluginInvocationTerminalKind::Http);
        assert_eq!(
            reserve_invocation_for_test(&mut connection, reservation, retry_at).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 3
        );
    }

    #[test]
    fn grant_revocation_fences_but_preserves_unresolved_http_ambiguity() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_193, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let operation_id = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::InvokeCommand,
                entry: PluginManifestEntry::Command {
                    command_id: PluginId::parse("run").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"revoked-http"),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        let degraded = record_failure(
            &mut connection,
            &plugin,
            PluginAttemptFailureCause::InternalError,
            now,
        )
        .unwrap();
        let retry_at = degraded.next_retry_at.unwrap();
        revoke_plugin_grants(
            &mut connection,
            OperationId::new(),
            RevokePluginGrantsRequest {
                plugin_id: degraded.plugin_id.clone(),
                package_generation: degraded.package_generation,
                permission_hash: manifest_permission_hash(&degraded.manifest).unwrap(),
            },
            now,
        )
        .unwrap();
        let first_disabled = get_installed_plugin(&connection, degraded.plugin_id).unwrap();
        assert_eq!(first_disabled.runtime_state, PluginRuntimeState::Disabled);
        assert!(!first_disabled.desired_enabled);
        assert!(
            list_plugin_grants(&connection, first_disabled.plugin_id.clone())
                .unwrap()
                .is_empty()
        );
        revoke_plugin_grants(
            &mut connection,
            OperationId::new(),
            RevokePluginGrantsRequest {
                plugin_id: first_disabled.plugin_id.clone(),
                package_generation: first_disabled.package_generation,
                permission_hash: manifest_permission_hash(&first_disabled.manifest).unwrap(),
            },
            now,
        )
        .unwrap();
        let disabled = get_installed_plugin(&connection, first_disabled.plugin_id.clone()).unwrap();
        assert_eq!(
            disabled.activation_epoch,
            first_disabled.activation_epoch + 1
        );
        let ambiguous = load_invocation(&connection, operation_id).unwrap();
        assert_eq!(ambiguous.state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(ambiguous.activation_epoch, disabled.activation_epoch);
        assert_eq!(
            transition_invocation_for_test(
                &mut connection,
                TransitionPluginInvocationRequest {
                    operation_id,
                    plugin_id: disabled.plugin_id.clone(),
                    package_generation: disabled.package_generation,
                    activation_epoch: disabled.activation_epoch,
                    expected_state: PluginInvocationState::AmbiguousHttp,
                    next_state: PluginInvocationState::DispatchingHttp,
                },
                retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        assert_eq!(
            load_invocation(&connection, operation_id).unwrap().state,
            PluginInvocationState::AmbiguousHttp
        );
    }

    #[test]
    fn expired_http_ambiguity_suspends_instead_of_being_silently_pruned() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_192, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let operation_id = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::InvokeCommand,
                entry: PluginManifestEntry::Command {
                    command_id: PluginId::parse("run").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"http"),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let later = now.checked_add((30 * 24 + 12).hours()).unwrap();
        let result = reconcile_packages(&mut connection, &store, later).unwrap();
        assert_eq!(result.disabled, vec![plugin.plugin_id.clone()]);
        let suspended = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        assert_eq!(suspended.runtime_state, PluginRuntimeState::Suspended);
        assert!(!suspended.desired_enabled);
        assert_eq!(suspended.last_error_code.as_deref(), Some("http_ambiguous"));
        assert_eq!(
            load_invocation(&connection, operation_id).unwrap_err(),
            RepositoryError::NotFound
        );
        assert!(list_plugin_invocations(&connection).unwrap().is_empty());
        let revision_after: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision_after, revision_before + 1);
        let event_type: String = connection
            .query_row(
                "SELECT event_type FROM events WHERE revision = ?1",
                [revision_after],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_type, EventType::PLUGIN_HEALTH_CHANGED);
        reconcile_packages(&mut connection, &store, later).unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_after
        );
    }

    #[test]
    fn concurrent_reservation_and_ambiguous_retry_share_one_active_gate() {
        use std::sync::{Arc, Barrier};

        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_194, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        drop(connection);

        let request = |operation_id| ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(operation_id.to_string().as_bytes()),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        let first = request(OperationId::new());
        let second = request(OperationId::new());
        let database = profile.path.join("junban.sqlite3");
        let connections = [
            crate::open_connection(&database).unwrap(),
            crate::open_connection(&database).unwrap(),
        ];
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for (mut connection, candidate) in
            connections.into_iter().zip([first.clone(), second.clone()])
        {
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                reserve_invocation_for_test(&mut connection, candidate, now)
            }));
        }
        barrier.wait();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(RepositoryError::Conflict)))
                .count(),
            1
        );
        let winner = if results[0].is_ok() { first } else { second };
        let mut connection = profile.connection();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: winner.operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: winner.operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                expected_state: PluginInvocationState::DispatchingHttp,
                next_state: PluginInvocationState::AmbiguousHttp,
            },
            now,
        )
        .unwrap();
        let newcomer = request(OperationId::new());
        reserve_invocation_for_test(&mut connection, newcomer.clone(), now).unwrap();
        assert_eq!(
            transition_invocation_for_test(
                &mut connection,
                TransitionPluginInvocationRequest {
                    operation_id: winner.operation_id,
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected_state: PluginInvocationState::AmbiguousHttp,
                    next_state: PluginInvocationState::DispatchingHttp,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        terminalize_invocation_for_test(
            &mut connection,
            newcomer.operation_id,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            now,
        )
        .unwrap();
        assert_eq!(
            transition_invocation_for_test(
                &mut connection,
                TransitionPluginInvocationRequest {
                    operation_id: winner.operation_id,
                    plugin_id: plugin.plugin_id,
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    expected_state: PluginInvocationState::AmbiguousHttp,
                    next_state: PluginInvocationState::DispatchingHttp,
                },
                now,
            )
            .unwrap()
            .state,
            PluginInvocationState::DispatchingHttp
        );
    }

    #[test]
    fn terminalization_and_exact_retry_race_cannot_reinsert_an_invocation() {
        use std::sync::{Arc, Barrier};

        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_193, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(&mut connection, &installed, &[Capability::Commands], now);
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let database = profile.path.join("junban.sqlite3");

        for iteration in 0..24 {
            let operation_id = OperationId::new();
            let request = ReservePluginInvocationRequest {
                operation_id,
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                hook_kind: PluginHookKind::InvokeCommand,
                entry: PluginManifestEntry::Command {
                    command_id: PluginId::parse("run").unwrap(),
                },
                request_sha256: Sha256Digest::of(format!("terminal-race-{iteration}").as_bytes()),
                delivery_operation_id: OperationId::new(),
                resync_session: None,
            };
            reserve_invocation_for_test(&mut connection, request.clone(), now).unwrap();

            let complete_connection = crate::open_connection(&database).unwrap();
            let retry_connection = crate::open_connection(&database).unwrap();
            let barrier = Arc::new(Barrier::new(3));
            let complete_barrier = Arc::clone(&barrier);
            let complete_plugin = plugin.clone();
            let complete = std::thread::spawn(move || {
                let mut connection = complete_connection;
                complete_barrier.wait();
                terminalize_invocation_for_test(
                    &mut connection,
                    operation_id,
                    complete_plugin.plugin_id,
                    complete_plugin.package_generation,
                    complete_plugin.activation_epoch,
                    now,
                )
            });
            let retry_barrier = Arc::clone(&barrier);
            let retry_request = request.clone();
            let retry = std::thread::spawn(move || {
                let mut connection = retry_connection;
                retry_barrier.wait();
                reserve_invocation_for_test(&mut connection, retry_request, now)
            });
            barrier.wait();
            complete.join().unwrap().unwrap();
            assert!(matches!(
                retry.join().unwrap().unwrap(),
                ReservedPluginInvocation::InFlightReplay(_)
                    | ReservedPluginInvocation::TerminalReplay(_)
            ));

            let terminal = reserve_invocation_for_test(&mut connection, request, now).unwrap();
            assert!(matches!(
                terminal,
                ReservedPluginInvocation::TerminalReplay(_)
            ));
            assert_eq!(
                connection
                    .query_row::<i64, _, _>(
                        "SELECT COUNT(*) FROM plugin_invocations WHERE operation_id = ?1",
                        [operation_id.to_string()],
                        |row| row.get(0),
                    )
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn invocation_reservation_prunes_safe_expiry_and_suspends_at_the_ceiling() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_195, 0);
        let installed = install_fixture(&mut connection, &store, now);
        let granted = grant_capabilities(
            &mut connection,
            &installed,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let plugin = activate_plugin(&mut connection, &store, &granted, now);
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let reserve = |operation_id| ReservePluginInvocationRequest {
            operation_id,
            plugin_id: plugin.plugin_id.clone(),
            package_generation: plugin.package_generation,
            activation_epoch: plugin.activation_epoch,
            hook_kind: PluginHookKind::InvokeCommand,
            entry: PluginManifestEntry::Command {
                command_id: PluginId::parse("run").unwrap(),
            },
            request_sha256: Sha256Digest::of(operation_id.to_string().as_bytes()),
            delivery_operation_id: OperationId::new(),
            resync_session: None,
        };
        reserve_invocation_for_test(&mut connection, reserve(OperationId::new()), now).unwrap();
        assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 1);
        let later = now.checked_add((31 * 24).hours()).unwrap();
        let current = OperationId::new();
        reserve_invocation_for_test(&mut connection, reserve(current), later).unwrap();
        assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 1);
        terminalize_invocation_for_test(
            &mut connection,
            current,
            plugin.plugin_id.clone(),
            plugin.package_generation,
            plugin.activation_epoch,
            later,
        )
        .unwrap();
        reserve_ambiguous(&mut connection, reserve(OperationId::new()), later);
        assert_eq!(list_plugin_invocations(&connection).unwrap().len(), 1);
        for _ in 1..PLUGIN_INVOCATIONS_PER_PLUGIN_MAX {
            reserve_ambiguous(&mut connection, reserve(OperationId::new()), later);
        }
        let limit_operation = OperationId::new();
        let limit_request = reserve(limit_operation);
        assert_eq!(
            reserve_invocation_for_test(&mut connection, limit_request.clone(), later).unwrap_err(),
            RepositoryError::OperationTooLarge
        );
        assert_eq!(
            reserve_invocation_for_test(&mut connection, limit_request.clone(), later).unwrap_err(),
            RepositoryError::OperationTooLarge
        );
        let mut changed_limit = limit_request;
        changed_limit.request_sha256 = Sha256Digest::of(b"changed-resource-limit");
        assert_eq!(
            reserve_invocation_for_test(&mut connection, changed_limit, later).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        let suspended = get_installed_plugin(&connection, plugin.plugin_id).unwrap();
        let retained = list_plugin_invocations(&connection).unwrap();
        assert_eq!(retained.len(), PLUGIN_INVOCATIONS_PER_PLUGIN_MAX);
        assert!(retained.iter().all(|invocation| {
            invocation.state == PluginInvocationState::AmbiguousHttp
                && invocation.activation_epoch == suspended.activation_epoch
        }));
        assert!(!suspended.desired_enabled);
        assert_eq!(suspended.runtime_state, PluginRuntimeState::Suspended);
        assert_eq!(suspended.failure_count, 3);
        assert_eq!(suspended.last_error_code.as_deref(), Some("resource_limit"));
        assert_eq!(suspended.activation_epoch, plugin.activation_epoch + 1);
        let revision: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, revision_before + 1);
    }

    #[test]
    fn typed_failures_and_due_retries_derive_the_bounded_series() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_198, 0);
        let installed = install_fixture(&mut connection, &store, now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let starting = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let failure_operation = OperationId::new();
        let first_request = RecordPluginAttemptFailureRequest {
            plugin_id: starting.plugin_id.clone(),
            package_generation: starting.package_generation,
            activation_epoch: starting.activation_epoch,
            cause: PluginAttemptFailureCause::Timeout,
        };
        let first = record_plugin_attempt_failure(
            &mut connection,
            failure_operation,
            first_request.clone(),
            now,
        )
        .unwrap();
        assert!(first.newly_committed);
        assert!(
            !record_plugin_attempt_failure(
                &mut connection,
                failure_operation,
                first_request.clone(),
                now,
            )
            .unwrap()
            .newly_committed
        );
        let mut changed_request = first_request;
        changed_request.cause = PluginAttemptFailureCause::GuestTrap;
        assert_eq!(
            record_plugin_attempt_failure(
                &mut connection,
                failure_operation,
                changed_request,
                now,
            )
            .unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );

        let mut failed = get_installed_plugin(&connection, starting.plugin_id.clone()).unwrap();
        assert_eq!(failed.runtime_state, PluginRuntimeState::Degraded);
        assert_eq!(failed.failure_count, 1);
        assert_eq!(failed.activation_epoch, starting.activation_epoch);
        assert_eq!(failed.last_error_code.as_deref(), Some("timeout"));
        let first_retry_at = now
            .checked_add(PLUGIN_FAILURE_BACKOFF_START_SECONDS.seconds())
            .unwrap();
        assert_eq!(failed.next_retry_at, Some(first_retry_at));

        let retry_request = DuePluginRetryRequest {
            plugin_id: failed.plugin_id.clone(),
            package_generation: failed.package_generation,
            activation_epoch: failed.activation_epoch,
            expected_runtime_state: failed.runtime_state,
            expected_next_retry_at: first_retry_at,
        };
        for stale_request in [
            DuePluginRetryRequest {
                package_generation: retry_request.package_generation + 1,
                ..retry_request.clone()
            },
            DuePluginRetryRequest {
                activation_epoch: retry_request.activation_epoch + 1,
                ..retry_request.clone()
            },
            DuePluginRetryRequest {
                expected_runtime_state: PluginRuntimeState::Failed,
                ..retry_request.clone()
            },
            DuePluginRetryRequest {
                expected_next_retry_at: first_retry_at.checked_add(1.seconds()).unwrap(),
                ..retry_request.clone()
            },
        ] {
            assert_eq!(
                retry_due_plugin(
                    &mut connection,
                    OperationId::new(),
                    stale_request,
                    first_retry_at,
                )
                .unwrap_err(),
                RepositoryError::Conflict
            );
        }
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 1
        );

        let retry_operation = OperationId::new();
        let retry_request = DuePluginRetryRequest {
            plugin_id: failed.plugin_id.clone(),
            package_generation: failed.package_generation,
            activation_epoch: failed.activation_epoch,
            expected_runtime_state: failed.runtime_state,
            expected_next_retry_at: first_retry_at,
        };
        assert_eq!(
            retry_due_plugin(&mut connection, retry_operation, retry_request.clone(), now,)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        let retry = retry_due_plugin(
            &mut connection,
            retry_operation,
            retry_request.clone(),
            first_retry_at,
        )
        .unwrap();
        assert!(retry.newly_committed);
        assert!(
            !retry_due_plugin(
                &mut connection,
                retry_operation,
                retry_request,
                first_retry_at,
            )
            .unwrap()
            .newly_committed
        );
        failed = get_installed_plugin(&connection, failed.plugin_id).unwrap();
        assert_eq!(failed.runtime_state, PluginRuntimeState::Starting);
        assert_eq!(failed.failure_count, 1);
        assert_eq!(failed.last_error_code.as_deref(), Some("timeout"));
        assert_eq!(failed.next_retry_at, None);
        assert_eq!(failed.activation_epoch, starting.activation_epoch + 1);
        assert_eq!(
            retry_due_plugin(
                &mut connection,
                OperationId::new(),
                DuePluginRetryRequest {
                    plugin_id: failed.plugin_id.clone(),
                    package_generation: failed.package_generation,
                    activation_epoch: starting.activation_epoch,
                    expected_runtime_state: PluginRuntimeState::Degraded,
                    expected_next_retry_at: first_retry_at,
                },
                first_retry_at,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );

        failed = record_failure(
            &mut connection,
            &failed,
            PluginAttemptFailureCause::Timeout,
            first_retry_at,
        )
        .unwrap();
        assert_eq!(failed.runtime_state, PluginRuntimeState::Failed);
        assert_eq!(failed.failure_count, 2);
        assert_eq!(failed.activation_epoch, starting.activation_epoch + 1);
        let second_retry_at = first_retry_at
            .checked_add((PLUGIN_FAILURE_BACKOFF_START_SECONDS * 2).seconds())
            .unwrap();
        assert_eq!(failed.next_retry_at, Some(second_retry_at));

        failed = retry_due(&mut connection, &failed, second_retry_at).unwrap();
        let retry_epoch = failed.activation_epoch;
        assert_eq!(failed.failure_count, 2);
        failed = record_failure(
            &mut connection,
            &failed,
            PluginAttemptFailureCause::Timeout,
            second_retry_at,
        )
        .unwrap();
        assert_eq!(failed.runtime_state, PluginRuntimeState::Suspended);
        assert_eq!(failed.failure_count, 3);
        assert_eq!(failed.activation_epoch, retry_epoch);
        assert!(!failed.desired_enabled);
        assert_eq!(failed.next_retry_at, None);
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 5
        );
        let manual = retry_plugin(
            &mut connection,
            &store,
            OperationId::new(),
            failed.plugin_id.clone(),
            second_retry_at,
        )
        .unwrap();
        assert_eq!(manual.event.revision, (revision_before + 6) as u64);
        let rearmed = get_installed_plugin(&connection, failed.plugin_id).unwrap();
        assert_eq!(rearmed.runtime_state, PluginRuntimeState::Starting);
        assert_eq!(rearmed.activation_epoch, failed.activation_epoch + 1);
        assert_eq!(rearmed.failure_count, 0);
        assert_eq!(rearmed.last_error_code, None);
        assert_eq!(rearmed.next_retry_at, None);
    }

    #[test]
    fn activation_cannot_overtake_starting_catch_up_reserved_or_effect_work() {
        for effect_committing in [false, true] {
            let profile = TestProfile::new();
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let now = Timestamp::constant(1_800_000_198, i32::from(effect_committing));
            let installed = install_fixture(&mut connection, &store, now);
            let granted = grant_capabilities(
                &mut connection,
                &installed,
                &[Capability::EventsSubscribe],
                now,
            );
            let active = activate_plugin(&mut connection, &store, &granted, now);
            connection
                .execute(
                    "UPDATE plugins SET runtime_state = 'starting' WHERE plugin_id = ?1",
                    [active.plugin_id.as_str()],
                )
                .unwrap();
            let plugin = get_installed_plugin(&connection, active.plugin_id).unwrap();
            task_ops::create_task(
                &mut connection,
                OperationId::new(),
                TaskId::new(),
                TaskDraft::new(TaskTitle::new("Activation blocker").unwrap()),
                now,
            )
            .unwrap();
            let operation_id = OperationId::new();
            let authorized = authorized_retained_event_reservation(
                &connection,
                &plugin,
                operation_id,
                PluginDeliveryMode::StartingCatchUp,
            );
            reserve_authorized_plugin_invocation(&mut connection, authorized.clone(), now).unwrap();
            if effect_committing {
                transition_authorized_plugin_invocation(
                    &mut connection,
                    AuthorizedTransitionPluginInvocationRequest {
                        request: TransitionPluginInvocationRequest {
                            operation_id,
                            plugin_id: plugin.plugin_id.clone(),
                            package_generation: plugin.package_generation,
                            activation_epoch: plugin.activation_epoch,
                            expected_state: PluginInvocationState::Reserved,
                            next_state: PluginInvocationState::EffectCommitting,
                        },
                        delivery: authorized.delivery.clone(),
                    },
                    now,
                )
                .unwrap();
            }
            connection
                .execute(
                    "UPDATE plugin_event_cursors
                     SET revision = (SELECT global_revision FROM app_state WHERE singleton = 1),
                         resync_required = 0, updated_at = ?2
                     WHERE plugin_id = ?1",
                    params![plugin.plugin_id.as_str(), now.to_string()],
                )
                .unwrap();
            assert_eq!(
                complete_plugin_activation(
                    &mut connection,
                    OperationId::new(),
                    CompletePluginActivationRequest {
                        plugin_id: plugin.plugin_id.clone(),
                        package_generation: plugin.package_generation,
                        activation_epoch: plugin.activation_epoch,
                    },
                    now,
                )
                .unwrap_err(),
                RepositoryError::Conflict
            );
            assert_eq!(
                get_installed_plugin(&connection, plugin.plugin_id.clone())
                    .unwrap()
                    .runtime_state,
                PluginRuntimeState::Starting
            );
            if effect_committing {
                assert_eq!(
                    commit_invocation_for_test(
                        &mut connection,
                        plan(CommitPluginInvocationRequest {
                            invocation_operation_id: operation_id,
                            plugin_id: plugin.plugin_id.clone(),
                            package_generation: plugin.package_generation,
                            activation_epoch: plugin.activation_epoch,
                            child_operation_id: None,
                            domain_effect: None,
                            kv_patch: None,
                            resync_kv: None,
                            cursor: Some(event_cursor_request(&plugin, &authorized.delivery)),
                            resync_session: None,
                        }),
                        now,
                    )
                    .unwrap_err(),
                    RepositoryError::Conflict
                );
            } else {
                assert_eq!(
                    transition_invocation_for_test(
                        &mut connection,
                        TransitionPluginInvocationRequest {
                            operation_id,
                            plugin_id: plugin.plugin_id,
                            package_generation: plugin.package_generation,
                            activation_epoch: plugin.activation_epoch,
                            expected_state: PluginInvocationState::Reserved,
                            next_state: PluginInvocationState::EffectCommitting,
                        },
                        now,
                    )
                    .unwrap_err(),
                    RepositoryError::Conflict
                );
            }
        }
    }

    #[test]
    fn activation_requires_exact_starting_epoch_and_ready_cursor() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_199, 0);
        let installed = install_fixture(&mut connection, &store, now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        connection
            .execute(
                "UPDATE plugins SET failure_count = 1, last_error_code = 'timeout'
                 WHERE plugin_id = ?1 AND runtime_state = 'starting'",
                [installed.plugin_id.as_str()],
            )
            .unwrap();
        let starting = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        let operation_id = OperationId::new();
        let request = CompletePluginActivationRequest {
            plugin_id: starting.plugin_id.clone(),
            package_generation: starting.package_generation,
            activation_epoch: starting.activation_epoch,
        };
        assert_eq!(
            complete_plugin_activation(&mut connection, operation_id, request.clone(), now)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        connection
            .execute(
                "UPDATE plugin_event_cursors
                 SET resync_required = 0, updated_at = ?2 WHERE plugin_id = ?1",
                params![starting.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        assert_eq!(
            complete_plugin_activation(&mut connection, operation_id, request.clone(), now)
                .unwrap_err(),
            RepositoryError::Conflict
        );
        connection
            .execute(
                "UPDATE plugin_event_cursors
                 SET revision = (SELECT global_revision FROM app_state WHERE singleton = 1),
                     updated_at = ?2 WHERE plugin_id = ?1",
                params![starting.plugin_id.as_str(), now.to_string()],
            )
            .unwrap();
        let completed =
            complete_plugin_activation(&mut connection, operation_id, request.clone(), now)
                .unwrap();
        assert!(completed.newly_committed);
        assert!(
            !complete_plugin_activation(&mut connection, operation_id, request.clone(), now)
                .unwrap()
                .newly_committed
        );
        let mut changed_request = request;
        changed_request.activation_epoch += 1;
        assert_eq!(
            complete_plugin_activation(&mut connection, operation_id, changed_request, now)
                .unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        let active = get_installed_plugin(&connection, starting.plugin_id.clone()).unwrap();
        assert_eq!(active.runtime_state, PluginRuntimeState::Active);
        assert_eq!(active.activation_epoch, starting.activation_epoch);
        assert_eq!(active.failure_count, 0);
        assert_eq!(active.last_error_code, None);
        assert_eq!(active.next_retry_at, None);
        let cursor = get_plugin_cursor(&connection, starting.plugin_id).unwrap();
        assert_eq!(cursor.revision, completed.event.revision);
        assert!(!cursor.resync_required);
    }

    #[test]
    fn startup_reconciliation_preserves_due_failure_series_before_retry() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_200, 0);
        let installed = install_fixture(&mut connection, &store, now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            installed.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let starting = get_installed_plugin(&connection, installed.plugin_id).unwrap();
        let degraded = record_failure(
            &mut connection,
            &starting,
            PluginAttemptFailureCause::Timeout,
            now,
        )
        .unwrap();
        let retry_at = degraded.next_retry_at.unwrap();
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let restart_at = retry_at.checked_add(1.seconds()).unwrap();
        reconcile_packages(&mut connection, &store, restart_at).unwrap();
        let recovered = get_installed_plugin(&connection, degraded.plugin_id.clone()).unwrap();
        assert_eq!(recovered.runtime_state, PluginRuntimeState::Degraded);
        assert_eq!(recovered.failure_count, 1);
        assert_eq!(recovered.last_error_code.as_deref(), Some("timeout"));
        assert_eq!(recovered.next_retry_at, Some(retry_at));
        assert_eq!(recovered.activation_epoch, degraded.activation_epoch + 1);
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );

        drop(connection);
        let mut connection = profile.connection();
        let reopened = get_installed_plugin(&connection, recovered.plugin_id.clone()).unwrap();
        assert_eq!(reopened, recovered);

        let retried = retry_due(&mut connection, &reopened, restart_at).unwrap();
        assert_eq!(retried.runtime_state, PluginRuntimeState::Starting);
        assert_eq!(retried.failure_count, 1);
        assert_eq!(retried.activation_epoch, recovered.activation_epoch + 1);
        assert_eq!(retried.last_error_code.as_deref(), Some("timeout"));
        assert_eq!(retried.next_retry_at, None);
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
    }

    #[tokio::test]
    async fn triggerless_graph_fence_survives_replay_backup_restore_and_normal_open() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_700_000_100, 0);
        let starting =
            install_named_fixture(&mut connection, &store, "aaa-starting", Vec::new(), now);
        let active = install_named_fixture(&mut connection, &store, "bbb-active", Vec::new(), now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            starting.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let active = activate_plugin(&mut connection, &store, &active, now);
        connection
            .execute(
                "UPDATE plugins SET failure_count = 1, last_error_code = 'timeout'
                 WHERE plugin_id = ?1 AND runtime_state = 'starting'",
                [starting.plugin_id.as_str()],
            )
            .unwrap();
        let starting = get_installed_plugin(&connection, starting.plugin_id).unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let operation_id = OperationId::new();
        let host_session_id = OperationId::new().to_string();
        let request = PluginGraphFenceRequest {
            operation_id,
            host_session_id: host_session_id.clone(),
            entries: [&starting, &active]
                .into_iter()
                .map(|plugin| PluginGraphFenceEntry {
                    plugin_id: plugin.plugin_id.clone(),
                    package_generation: plugin.package_generation,
                    activation_epoch: plugin.activation_epoch,
                    cause: PluginGraphFenceCause::SessionLost,
                    disposition: PluginGraphFenceDisposition::LoadedSibling,
                })
                .collect(),
        };
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let outcome = fence_plugin_graph(&mut connection, request.clone(), now).unwrap();
        assert!(outcome.mutation.newly_committed);
        assert_eq!(outcome.host_session_id, host_session_id);
        assert_eq!(outcome.results.len(), 2);
        assert_eq!(outcome.mutation.event.operation_id, operation_id);
        assert_eq!(
            outcome.mutation.event.event_type.as_str(),
            EventType::PLUGIN_HEALTH_CHANGED
        );
        assert_eq!(
            outcome.mutation.event.revision,
            (revision_before + 1) as u64
        );
        assert_eq!(
            outcome.mutation.event.affected.plugin_ids,
            outcome
                .results
                .iter()
                .map(|result| result.plugin_id.clone())
                .collect::<Vec<_>>()
        );
        assert!(outcome.results.iter().all(|result| {
            result.cause == PluginGraphFenceCause::SessionLost
                && result.disposition == PluginGraphFenceDisposition::LoadedSibling
                && result.new_activation_epoch == result.expected_activation_epoch + 1
        }));
        let starting_result = &outcome.results[0];
        assert_eq!(starting_result.plugin_id, starting.plugin_id);
        assert_eq!(
            starting_result.prior_runtime_state,
            PluginRuntimeState::Starting
        );
        assert_eq!(
            starting_result.target_runtime_state,
            PluginRuntimeState::Failed
        );
        assert_eq!(starting_result.failure_count, 2);
        assert!(starting_result.desired_enabled);
        let active_result = &outcome.results[1];
        assert_eq!(active_result.plugin_id, active.plugin_id);
        assert_eq!(
            active_result.prior_runtime_state,
            PluginRuntimeState::Active
        );
        assert_eq!(
            active_result.target_runtime_state,
            PluginRuntimeState::Degraded
        );
        assert_eq!(active_result.failure_count, 1);
        assert!(active_result.desired_enabled);
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 1
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM events WHERE operation_id = ?1",
                    [operation_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1",
                    [operation_id.to_string()],
                    |row| row.get(0),
                )
                .unwrap(),
            1
        );
        for result in &outcome.results {
            let stored = get_installed_plugin(&connection, result.plugin_id.clone()).unwrap();
            assert_eq!(stored.activation_epoch, result.new_activation_epoch);
            assert_eq!(stored.runtime_state, result.target_runtime_state);
            assert_eq!(stored.failure_count, result.failure_count);
            assert_eq!(stored.desired_enabled, result.desired_enabled);
            assert_eq!(
                stored.last_error_code.as_deref(),
                Some(PluginGraphFenceCause::SessionLost.error_code())
            );
        }
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let (canonical_request, canonical_response): (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let stored_request: PluginGraphFenceReceiptRequest =
            serde_json::from_str(&canonical_request).unwrap();
        let stored_response: PluginGraphFenceOutcome =
            serde_json::from_str(&canonical_response).unwrap();
        assert_eq!(canonical_json(&stored_request).unwrap(), canonical_request);
        assert_eq!(
            canonical_json(&stored_response).unwrap(),
            canonical_response
        );
        assert_eq!(stored_request.results, outcome.results);
        assert_eq!(stored_response.results, outcome.results);
        validate_plugin_graph_fence_receipt(operation_id, &canonical_request, &canonical_response)
            .unwrap();

        let replay = fence_plugin_graph(&mut connection, request.clone(), now).unwrap();
        assert_eq!(replay, outcome);
        assert!(!replay.mutation.newly_committed);
        let mut changed_request = request.clone();
        changed_request.host_session_id = OperationId::new().to_string();
        assert_eq!(
            fence_plugin_graph(&mut connection, changed_request, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );

        let mut skipped_request: PluginGraphFenceReceiptRequest =
            serde_json::from_str(&canonical_request).unwrap();
        let mut skipped_response: PluginGraphFenceOutcome =
            serde_json::from_str(&canonical_response).unwrap();
        skipped_request.results[1].cause = PluginGraphFenceCause::DependencyFailed;
        skipped_request.results[1].disposition = PluginGraphFenceDisposition::SkippedDependent;
        skipped_response.results[1].cause = PluginGraphFenceCause::DependencyFailed;
        skipped_response.results[1].disposition = PluginGraphFenceDisposition::SkippedDependent;
        let skipped_request = canonical_json(&skipped_request).unwrap();
        let skipped_response = canonical_json(&skipped_response).unwrap();
        assert!(
            validate_plugin_graph_fence_receipt(operation_id, &skipped_request, &skipped_response,)
                .is_err()
        );
        connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2, response_json = ?3
                 WHERE operation_id = ?1",
                params![operation_id.to_string(), skipped_request, skipped_response],
            )
            .unwrap();
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2, response_json = ?3
                 WHERE operation_id = ?1",
                params![
                    operation_id.to_string(),
                    &canonical_request,
                    &canonical_response
                ],
            )
            .unwrap();

        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        let candidate_connection = Connection::open(candidate.path()).unwrap();
        crate::plugin_validation::validate_plugin_authority(&candidate_connection).unwrap();
        let candidate_receipt: (String, String) = candidate_connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            candidate_receipt,
            (canonical_request.clone(), canonical_response.clone())
        );
        let candidate_backup =
            crate::backup_ops::create_backup(&candidate_connection, &profile.path).unwrap();
        drop(candidate_backup);
        drop(candidate_connection);
        crate::backup_ops::restore_backup(&mut connection, &profile.path, candidate).unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        let restored_receipt: (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            restored_receipt,
            (canonical_request.clone(), canonical_response.clone())
        );
        let restored_backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        drop(restored_backup);
        let restored_replay = fence_plugin_graph(&mut connection, request.clone(), now).unwrap();
        assert_eq!(restored_replay, outcome);
        assert!(!restored_replay.mutation.newly_committed);

        drop(connection);
        drop(store);
        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repository = owner.repository();
        let reopened_replay = repository.fence_plugin_graph(request, now).await.unwrap();
        assert_eq!(reopened_replay, outcome);
        assert!(!reopened_replay.mutation.newly_committed);
    }

    #[test]
    fn graph_fence_is_atomic_sorted_replayable_and_preserves_http_ambiguity() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_700_000_000, 0);
        let root = install_named_fixture(&mut connection, &store, "aaa-root", Vec::new(), now);
        let sibling =
            install_named_fixture(&mut connection, &store, "bbb-sibling", Vec::new(), now);
        let sibling = grant_capabilities(
            &mut connection,
            &sibling,
            &[Capability::Commands, Capability::Http],
            now,
        );
        let dependent = install_named_fixture(
            &mut connection,
            &store,
            "ccc-dependent",
            vec![Dependency {
                id: "aaa-root".to_owned(),
                requirement: "^1.0".to_owned(),
                services: Vec::new(),
            }],
            now,
        );
        let root = activate_plugin(&mut connection, &store, &root, now);
        let sibling = activate_plugin(&mut connection, &store, &sibling, now);
        set_plugin_desired_enabled(
            &mut connection,
            &store,
            OperationId::new(),
            dependent.plugin_id.clone(),
            true,
            now,
        )
        .unwrap();
        let dependent = get_installed_plugin(&connection, dependent.plugin_id).unwrap();
        connection
            .execute(
                "UPDATE plugins SET runtime_state = 'starting', failure_count = 2,
                     last_error_code = 'timeout', next_retry_at = NULL
                 WHERE plugin_id = ?1",
                [root.plugin_id.as_str()],
            )
            .unwrap();
        let root = get_installed_plugin(&connection, root.plugin_id).unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let http_operation = OperationId::new();
        let delivery_operation_id = OperationId::new();
        reserve_invocation_for_test(
            &mut connection,
            ReservePluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: sibling.plugin_id.clone(),
                package_generation: sibling.package_generation,
                activation_epoch: sibling.activation_epoch,
                hook_kind: PluginHookKind::InvokeCommand,
                entry: PluginManifestEntry::Command {
                    command_id: PluginId::parse("run").unwrap(),
                },
                request_sha256: Sha256Digest::of(b"graph-fence-http"),
                delivery_operation_id,
                resync_session: None,
            },
            now,
        )
        .unwrap();
        transition_invocation_for_test(
            &mut connection,
            TransitionPluginInvocationRequest {
                operation_id: http_operation,
                plugin_id: sibling.plugin_id.clone(),
                package_generation: sibling.package_generation,
                activation_epoch: sibling.activation_epoch,
                expected_state: PluginInvocationState::Reserved,
                next_state: PluginInvocationState::DispatchingHttp,
            },
            now,
        )
        .unwrap();

        let entries = vec![
            PluginGraphFenceEntry {
                plugin_id: root.plugin_id.clone(),
                package_generation: root.package_generation,
                activation_epoch: root.activation_epoch,
                cause: PluginGraphFenceCause::ChildFatal,
                disposition: PluginGraphFenceDisposition::Failing,
            },
            PluginGraphFenceEntry {
                plugin_id: sibling.plugin_id.clone(),
                package_generation: sibling.package_generation,
                activation_epoch: sibling.activation_epoch,
                cause: PluginGraphFenceCause::SessionLost,
                disposition: PluginGraphFenceDisposition::LoadedSibling,
            },
            PluginGraphFenceEntry {
                plugin_id: dependent.plugin_id.clone(),
                package_generation: dependent.package_generation,
                activation_epoch: dependent.activation_epoch,
                cause: PluginGraphFenceCause::DependencyFailed,
                disposition: PluginGraphFenceDisposition::SkippedDependent,
            },
        ];
        let revision_before: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: "not-a-session".to_owned(),
                    entries: entries.clone(),
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let mut invalid_role_entries = entries.clone();
        invalid_role_entries[1].disposition = PluginGraphFenceDisposition::Failing;
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: invalid_role_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let mut multiple_failing_entries = entries.clone();
        multiple_failing_entries[1].cause = PluginGraphFenceCause::ChildFatal;
        multiple_failing_entries[1].disposition = PluginGraphFenceDisposition::Failing;
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: multiple_failing_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let mut triggerless_with_skipped_entries = entries.clone();
        triggerless_with_skipped_entries[0].cause = PluginGraphFenceCause::SessionLost;
        triggerless_with_skipped_entries[0].disposition =
            PluginGraphFenceDisposition::LoadedSibling;
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: triggerless_with_skipped_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let mut duplicate_entries = entries.clone();
        duplicate_entries[1] = duplicate_entries[0].clone();
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: duplicate_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );

        let mut stale_entries = entries.clone();
        stale_entries[1].package_generation += 1;
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: stale_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let mut stale_entries = entries.clone();
        stale_entries[1].activation_epoch += 1;
        let stale_operation = OperationId::new();
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: stale_operation,
                    host_session_id: OperationId::new().to_string(),
                    entries: stale_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM operation_receipts WHERE operation_id = ?1",
                    [stale_operation.to_string()],
                    |row| row.get(0),
                )
                .unwrap(),
            0
        );
        for expected in [&root, &sibling, &dependent] {
            let stored = get_installed_plugin(&connection, expected.plugin_id.clone()).unwrap();
            assert_eq!(stored.activation_epoch, expected.activation_epoch);
            assert_eq!(stored.runtime_state, expected.runtime_state);
            assert_eq!(stored.failure_count, expected.failure_count);
        }

        connection
            .execute(
                "UPDATE plugins SET activation_epoch = ?2 WHERE plugin_id = ?1",
                params![dependent.plugin_id.as_str(), i64::MAX],
            )
            .unwrap();
        let mut epoch_overflow_entries = entries.clone();
        epoch_overflow_entries[2].activation_epoch = i64::MAX as u64;
        assert!(matches!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: epoch_overflow_entries,
                },
                now,
            ),
            Err(RepositoryError::Storage(_))
        ));
        connection
            .execute(
                "UPDATE plugins SET activation_epoch = ?2 WHERE plugin_id = ?1",
                params![
                    dependent.plugin_id.as_str(),
                    as_i64(dependent.activation_epoch, "activation epoch").unwrap()
                ],
            )
            .unwrap();
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before
        );

        let mut invalid_dependency_entries = entries.clone();
        invalid_dependency_entries[1].cause = PluginGraphFenceCause::DependencyFailed;
        invalid_dependency_entries[1].disposition = PluginGraphFenceDisposition::SkippedDependent;
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: invalid_dependency_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
        let mut overflow_entries = entries.clone();
        while overflow_entries.len() <= PLUGIN_GRAPH_FENCE_ENTRIES_MAX {
            let index = overflow_entries.len();
            overflow_entries.push(PluginGraphFenceEntry {
                plugin_id: PluginId::parse(format!("overflow-{index:02}")).unwrap(),
                package_generation: 1,
                activation_epoch: 1,
                cause: PluginGraphFenceCause::SessionLost,
                disposition: PluginGraphFenceDisposition::LoadedSibling,
            });
        }
        assert_eq!(
            fence_plugin_graph(
                &mut connection,
                PluginGraphFenceRequest {
                    operation_id: OperationId::new(),
                    host_session_id: OperationId::new().to_string(),
                    entries: overflow_entries,
                },
                now,
            )
            .unwrap_err(),
            RepositoryError::OperationTooLarge
        );

        let operation_id = OperationId::new();
        let host_session_id = OperationId::new().to_string();
        let request = PluginGraphFenceRequest {
            operation_id,
            host_session_id: host_session_id.clone(),
            entries,
        };
        let outcome = fence_plugin_graph(&mut connection, request.clone(), now).unwrap();
        assert!(outcome.mutation.newly_committed);
        assert_eq!(outcome.host_session_id, host_session_id);
        assert_eq!(outcome.results.len(), 3);
        assert!(
            outcome
                .results
                .windows(2)
                .all(|pair| pair[0].plugin_id < pair[1].plugin_id)
        );
        assert_eq!(
            outcome.mutation.event.affected.plugin_ids,
            outcome
                .results
                .iter()
                .map(|result| result.plugin_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            outcome.mutation.event.revision,
            (revision_before + 1) as u64
        );
        for entry in &outcome.results {
            assert_eq!(
                entry.new_activation_epoch,
                entry.expected_activation_epoch + 1
            );
            if entry.plugin_id.as_str() == "aaa-root" {
                assert_eq!(entry.prior_runtime_state, PluginRuntimeState::Starting);
                assert_eq!(entry.target_runtime_state, PluginRuntimeState::Suspended);
                assert_eq!(entry.failure_count, 3);
                assert!(!entry.desired_enabled);
            } else {
                assert_eq!(entry.target_runtime_state, PluginRuntimeState::Degraded);
                assert_eq!(entry.failure_count, 1);
                assert!(entry.desired_enabled);
            }
        }
        let ambiguous = load_invocation(&connection, http_operation).unwrap();
        assert_eq!(ambiguous.state, PluginInvocationState::AmbiguousHttp);
        assert_eq!(ambiguous.activation_epoch, sibling.activation_epoch + 1);
        assert_eq!(ambiguous.delivery_operation_id, delivery_operation_id);
        assert_eq!(ambiguous.error_code.as_deref(), Some("http_ambiguous"));

        let (stored_request, stored_response): (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let stored_request: PluginGraphFenceReceiptRequest =
            serde_json::from_str(&stored_request).unwrap();
        let stored_response: PluginGraphFenceOutcome =
            serde_json::from_str(&stored_response).unwrap();
        assert_eq!(stored_request.results, stored_response.results);
        assert_eq!(stored_request.results, outcome.results);

        let replay = fence_plugin_graph(&mut connection, request.clone(), now).unwrap();
        assert_eq!(replay, outcome);
        assert!(!replay.mutation.newly_committed);
        let mut changed_request = request.clone();
        changed_request.host_session_id = OperationId::new().to_string();
        assert_eq!(
            fence_plugin_graph(&mut connection, changed_request, now).unwrap_err(),
            RepositoryError::IdempotencyMismatch
        );
        assert_eq!(
            connection
                .query_row::<i64, _, _>(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
            revision_before + 1
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();

        let (canonical_request, canonical_response): (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        let mut multiple_failing_request: PluginGraphFenceReceiptRequest =
            serde_json::from_str(&canonical_request).unwrap();
        let mut multiple_failing_response: PluginGraphFenceOutcome =
            serde_json::from_str(&canonical_response).unwrap();
        multiple_failing_request.results[1].cause = PluginGraphFenceCause::ChildFatal;
        multiple_failing_request.results[1].disposition = PluginGraphFenceDisposition::Failing;
        multiple_failing_response.results[1].cause = PluginGraphFenceCause::ChildFatal;
        multiple_failing_response.results[1].disposition = PluginGraphFenceDisposition::Failing;
        let multiple_failing_request = canonical_json(&multiple_failing_request).unwrap();
        let multiple_failing_response = canonical_json(&multiple_failing_response).unwrap();
        assert!(
            validate_plugin_graph_fence_receipt(
                operation_id,
                &multiple_failing_request,
                &multiple_failing_response,
            )
            .is_err()
        );
        connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2, response_json = ?3
                 WHERE operation_id = ?1",
                params![
                    operation_id.to_string(),
                    multiple_failing_request,
                    multiple_failing_response
                ],
            )
            .unwrap();
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2, response_json = ?3
                 WHERE operation_id = ?1",
                params![
                    operation_id.to_string(),
                    &canonical_request,
                    &canonical_response
                ],
            )
            .unwrap();

        let mut corrupt_request: PluginGraphFenceReceiptRequest =
            serde_json::from_str(&canonical_request).unwrap();
        corrupt_request.host_session_id = OperationId::new().to_string();
        connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2 WHERE operation_id = ?1",
                params![
                    operation_id.to_string(),
                    canonical_json(&corrupt_request).unwrap()
                ],
            )
            .unwrap();
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        connection
            .execute(
                "UPDATE operation_receipts SET request_json = ?2 WHERE operation_id = ?1",
                params![operation_id.to_string(), canonical_request],
            )
            .unwrap();

        let mut corrupt_response: PluginGraphFenceOutcome =
            serde_json::from_str(&canonical_response).unwrap();
        corrupt_response.results[0].new_activation_epoch += 1;
        connection
            .execute(
                "UPDATE operation_receipts SET response_json = ?2 WHERE operation_id = ?1",
                params![
                    operation_id.to_string(),
                    canonical_json(&corrupt_response).unwrap()
                ],
            )
            .unwrap();
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        connection
            .execute(
                "UPDATE operation_receipts SET response_json = ?2 WHERE operation_id = ?1",
                params![operation_id.to_string(), &canonical_response],
            )
            .unwrap();

        let mut corrupt_response_event: PluginGraphFenceOutcome =
            serde_json::from_str(&canonical_response).unwrap();
        corrupt_response_event.mutation.event.operation_id = OperationId::new();
        connection
            .execute(
                "UPDATE operation_receipts SET response_json = ?2 WHERE operation_id = ?1",
                params![
                    operation_id.to_string(),
                    canonical_json(&corrupt_response_event).unwrap()
                ],
            )
            .unwrap();
        assert!(crate::backup_ops::create_backup(&connection, &profile.path).is_err());
        connection
            .execute(
                "UPDATE operation_receipts SET response_json = ?2 WHERE operation_id = ?1",
                params![operation_id.to_string(), canonical_response],
            )
            .unwrap();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        let (validated_request, validated_response): (String, String) = connection
            .query_row(
                "SELECT request_json, response_json FROM operation_receipts
                 WHERE operation_id = ?1",
                [operation_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        validate_plugin_graph_fence_receipt(operation_id, &validated_request, &validated_response)
            .unwrap();
        let backup = crate::backup_ops::create_backup(&connection, &profile.path).unwrap();
        let candidate = crate::backup_ops::prepare_restore(&profile.path, backup).unwrap();
        let candidate_connection = Connection::open(candidate.path()).unwrap();
        crate::backup_ops::create_backup(&candidate_connection, &profile.path).unwrap();
        drop(candidate_connection);
        drop(candidate);

        drop(connection);
        let mut connection = profile.connection();
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        let reopened_replay = fence_plugin_graph(&mut connection, request, now).unwrap();
        assert_eq!(reopened_replay, outcome);
        assert!(!reopened_replay.mutation.newly_committed);

        let dependent =
            get_installed_plugin(&connection, PluginId::parse("ccc-dependent").unwrap()).unwrap();
        let due = dependent.next_retry_at.unwrap();
        let dependent = retry_due(&mut connection, &dependent, due).unwrap();
        connection
            .execute(
                "UPDATE plugin_event_cursors
                 SET event_epoch = (SELECT event_epoch FROM app_state WHERE singleton = 1),
                     revision = (SELECT global_revision FROM app_state WHERE singleton = 1),
                     resync_required = 0, updated_at = ?2 WHERE plugin_id = ?1",
                params![dependent.plugin_id.as_str(), due.to_string()],
            )
            .unwrap();
        assert_eq!(
            complete_plugin_activation(
                &mut connection,
                OperationId::new(),
                CompletePluginActivationRequest {
                    plugin_id: dependent.plugin_id,
                    package_generation: dependent.package_generation,
                    activation_epoch: dependent.activation_epoch,
                },
                due,
            )
            .unwrap_err(),
            RepositoryError::Conflict
        );
    }

    #[test]
    fn reconciliation_disables_corrupt_authority_without_global_event() {
        let profile = TestProfile::new();
        let mut connection = profile.connection();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let now = Timestamp::constant(1_800_000_200, 0);
        let plugin = install_fixture(&mut connection, &store, now);
        let revision: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        fs::write(store.package_path(&plugin.package_sha256), b"corrupt").unwrap();

        let report = reconcile_packages(&mut connection, &store, now).unwrap();
        assert_eq!(report.disabled, vec![plugin.plugin_id.clone()]);
        let quarantined = get_installed_plugin(&connection, plugin.plugin_id.clone()).unwrap();
        assert_eq!(quarantined.activation_epoch, plugin.activation_epoch + 1);
        assert!(!quarantined.desired_enabled);
        assert_eq!(
            quarantined.runtime_state,
            PluginRuntimeState::ReverifyRequired
        );
        assert_eq!(quarantined.failure_count, 3);
        reconcile_packages(&mut connection, &store, now).unwrap();
        assert_eq!(
            get_installed_plugin(&connection, plugin.plugin_id)
                .unwrap()
                .activation_epoch,
            quarantined.activation_epoch
        );
        crate::plugin_validation::validate_plugin_authority(&connection).unwrap();
        let after_revision: i64 = connection
            .query_row(
                "SELECT global_revision FROM app_state WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_revision, revision);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_reverification_rotates_enabled_activation_without_constructing_runtime() {
        let profile = TestProfile::new();
        let now = Timestamp::constant(1_800_000_240, 0);
        let (bytes, authority, public_key) = package("restart-plugin", "1.0.0");
        let (epoch, revision) = {
            let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
            let repo = owner.repository();
            repo.trust_publisher(
                OperationId::new(),
                TrustPublisherRequest::new(public_key),
                now,
            )
            .await
            .unwrap();
            repo.set_community_plugin_policy(OperationId::new(), true, now)
                .await
                .unwrap();
            repo.publish_plugin_package(stage_bytes(&bytes))
                .await
                .unwrap();
            repo.install_plugin(
                OperationId::new(),
                InstallPluginRequest {
                    package: authority.clone(),
                    source: PluginInstallSource::CommunityRegistry,
                    replace_existing: false,
                    allow_downgrade: false,
                },
                now,
            )
            .await
            .unwrap();
            repo.set_plugin_desired_enabled(
                OperationId::new(),
                authority.plugin_id().clone(),
                true,
                now,
            )
            .await
            .unwrap();
            let plugin = repo
                .get_installed_plugin(authority.plugin_id().clone())
                .await
                .unwrap();
            let revision = repo.get_sync_state().await.unwrap().revision;
            drop(repo);
            drop(owner);
            (plugin.activation_epoch, revision)
        };

        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repo = owner.repository();
        let restarted = repo
            .get_installed_plugin(authority.plugin_id().clone())
            .await
            .unwrap();
        assert_eq!(restarted.activation_epoch, epoch + 1);
        assert!(restarted.desired_enabled);
        assert_eq!(restarted.runtime_state, PluginRuntimeState::Starting);
        assert_eq!(repo.get_sync_state().await.unwrap().revision, revision);
    }

    #[tokio::test]
    async fn startup_missing_package_hierarchy_disables_without_recreating_it() {
        let profile = TestProfile::new();
        let now = Timestamp::constant(1_800_000_249, 0);
        let (plugin_id, revision) = {
            let mut connection = profile.connection();
            let store = PluginPackageStore::open(&profile.path).unwrap();
            let installed = install_fixture(&mut connection, &store, now);
            let revision = connection
                .query_row(
                    "SELECT global_revision FROM app_state WHERE singleton = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap();
            (installed.plugin_id, revision)
        };
        fs::remove_dir_all(profile.path.join("plugins")).unwrap();

        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repo = owner.repository();
        let plugin = repo.get_installed_plugin(plugin_id).await.unwrap();
        assert!(!plugin.desired_enabled);
        assert_eq!(plugin.runtime_state, PluginRuntimeState::ReverifyRequired);
        assert_eq!(plugin.last_error_code.as_deref(), Some("package_invalid"));
        assert!(!profile.path.join("plugins").exists());
        assert_eq!(
            repo.get_sync_state().await.unwrap().revision,
            u64::try_from(revision).unwrap()
        );
    }

    #[tokio::test]
    async fn worker_requires_private_package_publication_before_metadata() {
        let profile = TestProfile::new();
        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repo = owner.repository();
        assert!(
            !profile.path.join("plugins").exists(),
            "an empty profile must not initialize plugin storage"
        );
        let now = Timestamp::constant(1_800_000_250, 0);
        let (bytes, authority, public_key) = package("worker-plugin", "1.0.0");
        repo.trust_publisher(
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .await
        .unwrap();
        repo.set_community_plugin_policy(OperationId::new(), true, now)
            .await
            .unwrap();
        let request = InstallPluginRequest {
            package: authority.clone(),
            source: PluginInstallSource::CommunityRegistry,
            replace_existing: false,
            allow_downgrade: false,
        };
        assert!(
            repo.install_plugin(OperationId::new(), request.clone(), now)
                .await
                .is_err()
        );
        assert_eq!(
            repo.get_installed_plugin_profile()
                .await
                .unwrap()
                .plugins
                .len(),
            0
        );
        assert_eq!(
            repo.publish_plugin_package(stage_bytes(&bytes))
                .await
                .unwrap(),
            authority
        );
        assert!(profile.path.join("plugins/packages/sha256").is_dir());
        assert!(
            repo.install_plugin(OperationId::new(), request, now)
                .await
                .unwrap()
                .committed()
                .is_some()
        );
        repo.create_backup().await.unwrap();
    }

    #[tokio::test]
    async fn staged_package_admission_cleans_failure_success_and_oversize_paths() {
        let profile = TestProfile::new();
        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repo = owner.repository();
        let now = Timestamp::constant(1_800_000_251, 0);
        let (bytes, authority, public_key) = package("admission-plugin", "1.0.0");
        let request = || InstallPluginRequest {
            package: authority.clone(),
            source: PluginInstallSource::CommunityRegistry,
            replace_existing: false,
            allow_downgrade: false,
        };

        let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let mut blocker = repo.block_worker(entered_sender, release_receiver);
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        assert!(matches!(
            blocker.as_mut().poll(&mut context),
            std::task::Poll::Pending
        ));
        entered_receiver.recv().unwrap();
        let cancelled_stage = stage_bytes(&bytes);
        let cancelled_path = cancelled_stage.path().to_path_buf();
        let admission = PluginPackageAdmission::inspect(cancelled_stage).unwrap();
        let mut cancelled =
            repo.install_plugin_admission(OperationId::new(), admission, request(), now);
        assert!(matches!(
            cancelled.as_mut().poll(&mut context),
            std::task::Poll::Pending
        ));
        drop(cancelled);
        release_sender.send(()).unwrap();
        blocker.await.unwrap();
        // This command is ordered after the cancelled admission and flushes it.
        repo.get_installed_plugin_profile().await.unwrap();
        assert!(!cancelled_path.exists());
        assert!(
            !profile
                .path
                .join("plugins/packages/sha256")
                .join(format!("{}.jbp", authority.package_sha256().as_str()))
                .exists()
        );

        let changed_stage = stage_bytes(&bytes);
        let changed_path = changed_stage.path().to_path_buf();
        let admission = PluginPackageAdmission::inspect(changed_stage).unwrap();
        let mut changed_bytes = bytes.clone();
        *changed_bytes.last_mut().unwrap() ^= 1;
        fs::write(&changed_path, changed_bytes).unwrap();
        assert!(
            repo.install_plugin_admission(OperationId::new(), admission, request(), now)
                .await
                .is_err()
        );
        assert!(!changed_path.exists());

        let rejected_stage = stage_bytes(&bytes);
        let rejected_path = rejected_stage.path().to_path_buf();
        let admission = PluginPackageAdmission::inspect(rejected_stage).unwrap();
        assert!(
            repo.install_plugin_admission(OperationId::new(), admission, request(), now)
                .await
                .is_err()
        );
        assert!(!rejected_path.exists());
        assert!(
            !profile
                .path
                .join("plugins/packages/sha256")
                .join(format!("{}.jbp", authority.package_sha256().as_str()))
                .exists()
        );

        repo.trust_publisher(
            OperationId::new(),
            TrustPublisherRequest::new(public_key),
            now,
        )
        .await
        .unwrap();
        repo.set_community_plugin_policy(OperationId::new(), true, now)
            .await
            .unwrap();
        let accepted_stage = stage_bytes(&bytes);
        let accepted_path = accepted_stage.path().to_path_buf();
        let admission = PluginPackageAdmission::inspect(accepted_stage).unwrap();
        let install_operation = OperationId::new();
        assert!(
            repo.install_plugin_admission(install_operation, admission, request(), now)
                .await
                .unwrap()
                .committed()
                .is_some()
        );
        assert!(!accepted_path.exists());
        let package_path = profile
            .path
            .join("plugins/packages/sha256")
            .join(format!("{}.jbp", authority.package_sha256().as_str()));
        assert!(package_path.exists());

        repo.uninstall_plugin(OperationId::new(), authority.plugin_id().clone(), now)
            .await
            .unwrap();
        assert!(!package_path.exists());
        let replay_stage = stage_bytes(&bytes);
        let replay_path = replay_stage.path().to_path_buf();
        let admission = PluginPackageAdmission::inspect(replay_stage).unwrap();
        let replay = repo
            .install_plugin_admission(install_operation, admission, request(), now)
            .await
            .unwrap();
        assert!(!replay.committed().unwrap().newly_committed);
        assert!(!replay_path.exists());
        assert!(!package_path.exists());
        assert!(
            repo.get_installed_plugin_profile()
                .await
                .unwrap()
                .plugins
                .is_empty()
        );

        let malformed = stage_bytes(b"not-a-package");
        let malformed_path = malformed.path().to_path_buf();
        assert!(PluginPackageAdmission::inspect(malformed).is_err());
        assert!(!malformed_path.exists());

        let oversize_path =
            std::env::temp_dir().join(format!("junban-plugin-oversize-{}", Uuid::now_v7()));
        let oversize = fs::File::create(&oversize_path).unwrap();
        oversize
            .set_len(junban_plugin_sdk::PACKAGE_BYTES_MAX as u64 + 1)
            .unwrap();
        drop(oversize);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&oversize_path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let oversize = StagedFile::new(
            oversize_path.clone(),
            junban_plugin_sdk::PACKAGE_BYTES_MAX as u64 + 1,
        );
        assert!(PluginPackageAdmission::inspect(oversize).is_err());
        assert!(!oversize_path.exists());
    }

    #[tokio::test]
    async fn bounded_worker_queue_retains_only_metadata_for_concurrent_maximum_packages() {
        use std::task::Poll;

        let _memory_guard = PackageMemoryTestGuard::acquire();
        let profile = TestProfile::new();
        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repo = owner.repository();
        let package_len = junban_plugin_sdk::PACKAGE_BYTES_MAX as u64;
        let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let mut blocker = repo.block_worker(entered_sender, release_receiver);
        let waker = std::task::Waker::noop();
        let mut context = std::task::Context::from_waker(waker);
        assert!(matches!(blocker.as_mut().poll(&mut context), Poll::Pending));
        entered_receiver.recv().unwrap();
        #[cfg(target_os = "linux")]
        let resident_before = resident_kib();

        let mut stage_paths = Vec::new();
        let mut queued = Vec::new();
        for _ in 0..crate::WORKER_QUEUE_CAPACITY {
            let stage = stage_sparse_package(package_len);
            stage_paths.push(stage.path().to_path_buf());
            let mut future = repo.publish_plugin_package(stage);
            assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
            queued.push(future);
        }
        #[cfg(target_os = "linux")]
        assert!(resident_kib().saturating_sub(resident_before) < 64 * 1_024);

        let rejected = stage_sparse_package(package_len);
        let rejected_path = rejected.path().to_path_buf();
        let mut rejected_future = repo.publish_plugin_package(rejected);
        assert!(matches!(
            rejected_future.as_mut().poll(&mut context),
            Poll::Ready(Err(RepositoryError::Storage(message)))
                if message == "database worker queue is full"
        ));
        drop(rejected_future);
        assert!(!rejected_path.exists());

        queued.drain(..crate::WORKER_QUEUE_CAPACITY / 2);
        release_sender.send(()).unwrap();
        blocker.await.unwrap();
        for future in queued {
            assert!(matches!(future.await, Err(RepositoryError::Storage(_))));
        }
        assert!(stage_paths.iter().all(|path| !path.exists()));
    }

    #[test]
    fn package_store_cleanup_removes_only_old_unreferenced_digest_objects() {
        use std::time::{Duration, SystemTime};

        let profile = TestProfile::new();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let (bytes, authority, _) = package("orphan-plugin", "1.0.0");
        publish_bytes(&store, &bytes).unwrap();
        let path = store.package_path(authority.package_sha256());
        let file = fs::File::open(&path).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7_200)),
        )
        .unwrap();
        let referenced = HashSet::from([authority.package_sha256().to_string()]);
        assert_eq!(store.cleanup_orphans(&referenced).unwrap().removed, 0);
        assert!(path.exists());
        assert_eq!(store.cleanup_orphans(&HashSet::new()).unwrap().removed, 1);
        assert!(!path.exists());

        let non_digest = path.parent().unwrap().join("not-a-package.jbp");
        fs::write(&non_digest, b"junk").unwrap();
        let file = fs::File::open(&non_digest).unwrap();
        file.set_times(
            fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(7_200)),
        )
        .unwrap();
        assert_eq!(store.cleanup_orphans(&HashSet::new()).unwrap().removed, 0);
        assert!(non_digest.exists());
    }

    #[tokio::test]
    async fn concurrent_streamed_publication_is_bounded() {
        let _memory_guard = PackageMemoryTestGuard::acquire();
        let profile = TestProfile::new();
        let owner = crate::ProfileOwner::open(profile.path.clone()).unwrap();
        let repo = owner.repository();
        // Keep ordinary parallel workspace runs responsive. Optimized RSS evidence
        // opts in to two exact component-cap packages through the same path.
        let maximum_evidence = std::env::var_os("JUNBAN_ASSERT_PLUGIN_PACKAGE_RSS").is_some();
        let component_size = if maximum_evidence {
            junban_plugin_sdk::COMPONENT_BYTES_MAX
        } else {
            // The retained fixture may grow; this ordinary target must still leave
            // room for its encoded padding.
            256 * 1024
        };
        let component = component_with_size(component_size);
        let (_, base, _) = package("maximum-plugin", "1.0.0");
        let mut manifest = base.manifest().clone();
        manifest.component_sha256 = Sha256Digest::of(&component).to_string();
        let key = SigningKey::from_bytes(&KEY_BYTES);
        let bytes = pack_package(&manifest, &component, &key).unwrap();
        drop(component);
        let package_len = bytes.len() as u64;
        let first_stage = stage_bytes(&bytes);
        let second_stage = stage_bytes(&bytes);
        drop(bytes);
        #[cfg(target_os = "linux")]
        let (resident_before, resident_peak, monitoring, monitor) = {
            use std::sync::{
                Arc,
                atomic::{AtomicBool, AtomicU64, Ordering},
            };

            let resident_before = resident_kib();
            let resident_peak = Arc::new(AtomicU64::new(resident_before));
            let monitoring = Arc::new(AtomicBool::new(true));
            let monitor_peak = Arc::clone(&resident_peak);
            let monitor_running = Arc::clone(&monitoring);
            let monitor = std::thread::spawn(move || {
                while monitor_running.load(Ordering::Acquire) {
                    monitor_peak.fetch_max(resident_kib(), Ordering::AcqRel);
                    std::thread::yield_now();
                }
                monitor_peak.fetch_max(resident_kib(), Ordering::AcqRel);
            });
            (resident_before, resident_peak, monitoring, monitor)
        };
        let (first, second) = tokio::join!(
            repo.publish_plugin_package(first_stage),
            repo.publish_plugin_package(second_stage),
        );
        let authority = first.unwrap();
        assert_eq!(second.unwrap(), authority);
        #[cfg(target_os = "linux")]
        {
            use std::sync::atomic::Ordering;

            monitoring.store(false, Ordering::Release);
            monitor.join().unwrap();
            let resident_peak = resident_peak.load(Ordering::Acquire);
            let resident_delta = resident_peak.saturating_sub(resident_before);
            eprintln!(
                "concurrent package RSS: baseline={resident_before} KiB, peak={resident_peak} KiB, delta={resident_delta} KiB"
            );
            // Other storage tests share this process and can change global RSS.
            // The optimized exact-test evidence opts into the isolated bound.
            if maximum_evidence {
                assert!(
                    resident_delta < 96 * 1_024,
                    "concurrent streamed publication retained {resident_delta} KiB"
                );
            }
        }
        assert_eq!(authority.component_size(), component_size as u64);
        let path = PluginPackageStore::open(&profile.path)
            .unwrap()
            .package_path(authority.package_sha256());
        assert_eq!(fs::metadata(&path).unwrap().len(), package_len);
    }

    #[cfg(unix)]
    #[test]
    fn package_store_rejects_links_executables_and_corrupt_overwrites() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let profile = TestProfile::new();
        let store = PluginPackageStore::open(&profile.path).unwrap();
        let (bytes, authority, _) = package("file-plugin", "1.0.0");
        let destination = store.package_path(authority.package_sha256());
        let source = profile.path.join("source.jbp");
        fs::write(&source, &bytes).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();

        let source_link = profile.path.join("source-link.jbp");
        symlink(&source, &source_link).unwrap();
        assert!(matches!(
            store.publish(StagedFile::new(source_link.clone(), bytes.len() as u64)),
            Err(crate::PackageStoreError::UnsafePath)
        ));
        assert!(fs::symlink_metadata(&source_link).is_err());

        let source_hard_link = profile.path.join("source-hard-link.jbp");
        fs::hard_link(&source, &source_hard_link).unwrap();
        assert!(matches!(
            store.publish(StagedFile::new(
                source_hard_link.clone(),
                bytes.len() as u64
            )),
            Err(crate::PackageStoreError::UnsafePath)
        ));
        assert!(!source_hard_link.exists());

        let executable_source = profile.path.join("source-executable.jbp");
        fs::write(&executable_source, &bytes).unwrap();
        fs::set_permissions(&executable_source, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            store.publish(StagedFile::new(
                executable_source.clone(),
                bytes.len() as u64
            )),
            Err(crate::PackageStoreError::UnsafePath)
        ));
        assert!(!executable_source.exists());

        symlink(&source, &destination).unwrap();
        assert!(matches!(
            publish_bytes(&store, &bytes),
            Err(crate::PackageStoreError::UnsafePath)
        ));
        fs::remove_file(&destination).unwrap();

        fs::hard_link(&source, &destination).unwrap();
        assert!(matches!(
            publish_bytes(&store, &bytes),
            Err(crate::PackageStoreError::UnsafePath)
        ));
        fs::remove_file(&destination).unwrap();

        fs::write(&destination, &bytes).unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            publish_bytes(&store, &bytes),
            Err(crate::PackageStoreError::UnsafePath)
        ));
        fs::remove_file(&destination).unwrap();

        fs::write(&destination, b"different bytes").unwrap();
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(
            publish_bytes(&store, &bytes),
            Err(crate::PackageStoreError::AuthorityMismatch)
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"different bytes");
    }
}
