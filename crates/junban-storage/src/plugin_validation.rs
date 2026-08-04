//! Strict validation for persisted plugin authority.

use std::collections::BTreeMap;

use jiff::Timestamp;
use junban_app::RepositoryError;
use junban_domain::{OperationId, TaskId, decode_sha256_hex};
use junban_plugin_sdk::{
    Capability, DependencyLock, HostFailureCode, InstalledPackage, Permission, PermissionScope,
    RuntimeManifest, SettingSchema, permission_set_hash, scope_hash, validate_dependency_locks,
    validate_permission_grants,
};
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};

const PLUGINS_MAX: i64 = 64;
const SETTINGS_BYTES_MAX: i64 = 65_536;
const KV_KEYS_MAX: i64 = 256;
const KV_VALUE_BYTES_MAX: i64 = 65_536;
const KV_BYTES_MAX: i64 = 2 * 1024 * 1024;
const INVOCATIONS_PER_PLUGIN_MAX: i64 = 64;
const INVOCATIONS_PROFILE_MAX: i64 = 256;
const INVOCATION_BYTES_PER_PLUGIN_MAX: i64 = 1024 * 1024;
const INVOCATION_BYTES_PROFILE_MAX: i64 = 4 * 1024 * 1024;

#[derive(Debug)]
struct PluginRow {
    plugin_id: String,
    package_generation: i64,
    activation_epoch: i64,
    package_sha256: String,
    component_sha256: String,
    publisher_key_id: String,
    version: String,
    manifest_json: String,
    permission_hash: String,
    compatibility: String,
    desired_enabled: i64,
    runtime_state: String,
    failure_count: i64,
    last_error_code: Option<String>,
    next_retry_at: Option<String>,
    installed_at: String,
    updated_at: String,
}

struct LoadedPlugin {
    row: PluginRow,
    manifest: RuntimeManifest,
}

pub(crate) fn validate_plugin_authority(connection: &Connection) -> Result<(), RepositoryError> {
    let (next_generation, allocator_updated): (i64, String) = connection
        .query_row(
            "SELECT next_package_generation, updated_at
             FROM plugin_profile_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage)?;
    if table_count(connection, "plugin_profile_state")? != 1 || next_generation < 1 {
        return invalid("profile allocator");
    }
    canonical_timestamp(&allocator_updated)?;

    let (community_enabled, policy_updated): (i64, String) = connection
        .query_row(
            "SELECT community_enabled, updated_at FROM plugin_policy WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage)?;
    if table_count(connection, "plugin_policy")? != 1 || !strict_bool(community_enabled) {
        return invalid("plugin policy");
    }
    canonical_timestamp(&policy_updated)?;

    let plugins = load_plugins(connection, next_generation)?;
    validate_trust(connection)?;
    validate_grants(connection, &plugins)?;
    validate_settings(connection, &plugins)?;
    validate_kv(connection)?;
    validate_locks(connection, &plugins)?;
    validate_cursors(connection)?;
    validate_invocations(connection, &plugins)?;
    Ok(())
}

fn load_plugins(
    connection: &Connection,
    next_generation: i64,
) -> Result<Vec<LoadedPlugin>, RepositoryError> {
    if table_count(connection, "plugins")? > PLUGINS_MAX {
        return invalid("installed plugin ceiling");
    }
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, package_generation, activation_epoch, package_sha256,
                    component_sha256, publisher_key_id, version, manifest_json,
                    permission_hash, compatibility, desired_enabled, runtime_state,
                    failure_count, last_error_code, next_retry_at, installed_at, updated_at
             FROM plugins ORDER BY plugin_id",
        )
        .map_err(storage)?;
    let rows = statement
        .query_map([], |row| {
            Ok(PluginRow {
                plugin_id: row.get(0)?,
                package_generation: row.get(1)?,
                activation_epoch: row.get(2)?,
                package_sha256: row.get(3)?,
                component_sha256: row.get(4)?,
                publisher_key_id: row.get(5)?,
                version: row.get(6)?,
                manifest_json: row.get(7)?,
                permission_hash: row.get(8)?,
                compatibility: row.get(9)?,
                desired_enabled: row.get(10)?,
                runtime_state: row.get(11)?,
                failure_count: row.get(12)?,
                last_error_code: row.get(13)?,
                next_retry_at: row.get(14)?,
                installed_at: row.get(15)?,
                updated_at: row.get(16)?,
            })
        })
        .map_err(storage)?;
    let mut loaded = Vec::new();
    for result in rows {
        let row = result.map_err(storage)?;
        if row.package_generation < 1
            || row.package_generation >= next_generation
            || row.activation_epoch < 0
            || !strict_bool(row.desired_enabled)
            || row.failure_count < 0
            || row.failure_count > 3
            || !matches!(
                row.runtime_state.as_str(),
                "disabled"
                    | "starting"
                    | "active"
                    | "degraded"
                    | "failed"
                    | "suspended"
                    | "reverify_required"
            )
        {
            return invalid("installed plugin scalar authority");
        }
        canonical_hash(&row.package_sha256)?;
        canonical_hash(&row.component_sha256)?;
        canonical_hash(&row.publisher_key_id)?;
        canonical_hash(&row.permission_hash)?;
        canonical_timestamp(&row.installed_at)?;
        canonical_timestamp(&row.updated_at)?;
        if canonical_timestamp(&row.updated_at)? < canonical_timestamp(&row.installed_at)? {
            return invalid("installed plugin timestamp order");
        }
        if let Some(timestamp) = &row.next_retry_at {
            canonical_timestamp(timestamp)?;
        }
        if row
            .last_error_code
            .as_deref()
            .is_some_and(|code| !valid_error_code(code))
        {
            return invalid("plugin error code");
        }
        if row.failure_count == 0 && (row.last_error_code.is_some() || row.next_retry_at.is_some())
        {
            return invalid("plugin failure authority");
        }

        let manifest = RuntimeManifest::parse_canonical(row.manifest_json.as_bytes())
            .map_err(|_| invalid_error("canonical plugin manifest"))?;
        let expected_permission_hash = hash_hex(
            &permission_set_hash(&manifest.permissions)
                .map_err(|_| invalid_error("manifest permission authority"))?,
        );
        if manifest.id != row.plugin_id
            || manifest.version != row.version
            || manifest.component_sha256 != row.component_sha256
            || manifest.publisher.key_id != row.publisher_key_id
            || manifest.junban_compatibility != row.compatibility
            || expected_permission_hash != row.permission_hash
        {
            return invalid("manifest column authority");
        }
        loaded.push(LoadedPlugin { row, manifest });
    }
    Ok(loaded)
}

fn validate_trust(connection: &Connection) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT key_id, public_key, status, trusted_at, revoked_at
             FROM plugin_publisher_trust ORDER BY key_id",
        )
        .map_err(storage)?;
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
        .map_err(storage)?;
    let mut count = 0_usize;
    for result in rows {
        let (key_id, public_key, status, trusted_at, revoked_at) = result.map_err(storage)?;
        count += 1;
        canonical_hash(&key_id)?;
        if public_key.len() != 32 || hash_hex(&Sha256::digest(&public_key)) != key_id {
            return invalid("publisher key fingerprint");
        }
        match (status.as_str(), revoked_at.as_deref()) {
            ("active", None) => {}
            ("revoked", Some(revoked)) => {
                if canonical_timestamp(revoked)? < canonical_timestamp(&trusted_at)? {
                    return invalid("publisher trust timestamp order");
                }
            }
            _ => return invalid("publisher trust status"),
        }
        canonical_timestamp(&trusted_at)?;
    }
    if count > junban_plugin_sdk::SIGNER_TRUST_RECORDS_MAX {
        return invalid("publisher trust ceiling");
    }
    Ok(())
}

fn validate_grants(
    connection: &Connection,
    plugins: &[LoadedPlugin],
) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, package_generation, capability, scope_json, scope_hash,
                    permission_hash, granted_at
             FROM plugin_grants ORDER BY plugin_id, capability, scope_hash",
        )
        .map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    let mut by_plugin: BTreeMap<String, Vec<Permission>> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(storage)? {
        let plugin_id: String = row.get(0).map_err(storage)?;
        let package_generation: i64 = row.get(1).map_err(storage)?;
        let capability_text: String = row.get(2).map_err(storage)?;
        let scope_json: String = row.get(3).map_err(storage)?;
        let stored_scope_hash: String = row.get(4).map_err(storage)?;
        let stored_permission_hash: String = row.get(5).map_err(storage)?;
        let granted_at: String = row.get(6).map_err(storage)?;
        let plugin = plugin(plugins, &plugin_id)?;
        if package_generation != plugin.row.package_generation
            || stored_permission_hash != plugin.row.permission_hash
        {
            return invalid("grant generation authority");
        }
        if canonical_timestamp(&granted_at)? < canonical_timestamp(&plugin.row.installed_at)? {
            return invalid("grant timestamp order");
        }
        canonical_hash(&stored_scope_hash)?;
        canonical_hash(&stored_permission_hash)?;
        let capability: Capability = parse_json(&format!("\"{capability_text}\""), "capability")?;
        if capability.as_str() != capability_text {
            return invalid("grant capability");
        }
        let scope: PermissionScope = parse_json(&scope_json, "grant scope")?;
        if serde_json::to_string(&scope).map_err(storage)? != scope_json {
            return invalid("canonical grant scope");
        }
        let permission = Permission { capability, scope };
        let calculated = scope_hash(&permission).map_err(|_| invalid_error("grant scope"))?;
        if hash_hex(&calculated) != stored_scope_hash {
            return invalid("grant scope hash");
        }
        let grants = by_plugin.entry(plugin_id).or_default();
        grants.push(permission);
        if grants.len() > junban_plugin_sdk::PERMISSIONS_MAX {
            return invalid("plugin grant ceiling");
        }
    }
    for plugin in plugins {
        let granted = by_plugin.remove(&plugin.row.plugin_id).unwrap_or_default();
        let authority = validate_permission_grants(&plugin.manifest.permissions, &granted)
            .map_err(|_| invalid_error("plugin grants"))?;
        if hash_hex(&authority.requested_hash) != plugin.row.permission_hash {
            return invalid("grant requested permission hash");
        }
    }
    if !by_plugin.is_empty() {
        return invalid("orphan plugin grant");
    }
    Ok(())
}

fn validate_settings(
    connection: &Connection,
    plugins: &[LoadedPlugin],
) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, setting_key, value_json, updated_at
             FROM plugin_settings ORDER BY plugin_id, setting_key",
        )
        .map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    let mut counts: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(storage)? {
        let plugin_id: String = row.get(0).map_err(storage)?;
        let key: String = row.get(1).map_err(storage)?;
        let value_json: String = row.get(2).map_err(storage)?;
        let updated_at: String = row.get(3).map_err(storage)?;
        canonical_timestamp(&updated_at)?;
        let plugin = plugin(plugins, &plugin_id)?;
        let declaration = plugin
            .manifest
            .settings
            .iter()
            .find(|setting| setting.id == key)
            .ok_or_else(|| invalid_error("undeclared plugin setting"))?;
        validate_setting_value(&declaration.schema, &value_json)?;
        let aggregate = counts.entry(plugin_id).or_default();
        aggregate.0 += 1;
        aggregate.1 = aggregate
            .1
            .checked_add(i64::try_from(value_json.len()).map_err(storage)?)
            .ok_or_else(|| invalid_error("plugin settings aggregate"))?;
        if aggregate.0 > 64 || aggregate.1 > SETTINGS_BYTES_MAX {
            return invalid("plugin settings aggregate");
        }
    }
    Ok(())
}

fn validate_setting_value(schema: &SettingSchema, raw: &str) -> Result<(), RepositoryError> {
    let value: serde_json::Value = parse_json(raw, "plugin setting value")?;
    if serde_json::to_string(&value).map_err(storage)? != raw {
        return invalid("canonical plugin setting value");
    }
    let valid = match schema {
        SettingSchema::Text {
            min_bytes,
            max_bytes,
            ..
        } => value.as_str().is_some_and(|text| {
            text.len() >= usize::from(*min_bytes)
                && text.len() <= usize::from(*max_bytes)
                && valid_setting_text(text)
        }),
        SettingSchema::Integer { min, max, step, .. } => value.as_i64().is_some_and(|number| {
            number >= *min
                && number <= *max
                && number
                    .checked_sub(*min)
                    .is_some_and(|delta| delta % *step == 0)
        }),
        SettingSchema::Boolean { .. } => value.is_boolean(),
        SettingSchema::Select { options, .. } => value
            .as_str()
            .is_some_and(|id| options.iter().any(|option| option.id == id)),
    };
    if valid {
        Ok(())
    } else {
        invalid("plugin setting type")
    }
}

fn validate_kv(connection: &Connection) -> Result<(), RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, key, TYPEOF(value), LENGTH(value), updated_at
             FROM plugin_kv ORDER BY plugin_id, key",
        )
        .map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    let mut aggregates: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(storage)? {
        let plugin_id: String = row.get(0).map_err(storage)?;
        let key: String = row.get(1).map_err(storage)?;
        let value_type: String = row.get(2).map_err(storage)?;
        let value_bytes: i64 = row.get(3).map_err(storage)?;
        let updated_at: String = row.get(4).map_err(storage)?;
        canonical_timestamp(&updated_at)?;
        if key.is_empty()
            || key.len() > 128
            || !valid_kv_key(&key)
            || value_type != "blob"
            || !(0..=KV_VALUE_BYTES_MAX).contains(&value_bytes)
        {
            return invalid("plugin KV scalar authority");
        }
        let aggregate = aggregates.entry(plugin_id).or_default();
        aggregate.0 += 1;
        aggregate.1 = aggregate
            .1
            .checked_add(value_bytes)
            .ok_or_else(|| invalid_error("plugin KV aggregate"))?;
        if aggregate.0 > KV_KEYS_MAX || aggregate.1 > KV_BYTES_MAX {
            return invalid("plugin KV aggregate");
        }
    }
    Ok(())
}

fn validate_locks(
    connection: &Connection,
    plugins: &[LoadedPlugin],
) -> Result<(), RepositoryError> {
    let packages: Vec<_> = plugins
        .iter()
        .map(|plugin| InstalledPackage {
            manifest: &plugin.manifest,
            package_generation: u64::try_from(plugin.row.package_generation).unwrap_or(0),
            package_sha256: &plugin.row.package_sha256,
        })
        .collect();
    let mut statement = connection
        .prepare(
            "SELECT plugin_id, dependency_id, version_requirement, resolved_version,
                    dependency_package_generation, dependency_package_sha256, updated_at
             FROM plugin_dependency_locks ORDER BY plugin_id, dependency_id",
        )
        .map_err(storage)?;
    let rows = statement
        .query_map([], |row| {
            let generation = row.get::<_, i64>(4)?;
            let generation = u64::try_from(generation).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    4,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })?;
            Ok((
                DependencyLock {
                    plugin_id: row.get(0)?,
                    dependency_id: row.get(1)?,
                    version_requirement: row.get(2)?,
                    resolved_version: row.get(3)?,
                    dependency_package_generation: generation,
                    dependency_package_sha256: row.get(5)?,
                },
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(storage)?;
    let mut locks = Vec::new();
    for result in rows {
        let (lock, updated_at) = result.map_err(storage)?;
        canonical_timestamp(&updated_at)?;
        locks.push(lock);
        if locks.len()
            > usize::try_from(PLUGINS_MAX).unwrap_or(0) * junban_plugin_sdk::PLUGIN_DEPENDENCIES_MAX
        {
            return invalid("plugin dependency lock ceiling");
        }
    }
    validate_dependency_locks(&packages, &locks)
        .map_err(|_| invalid_error("plugin dependency authority"))
}

fn validate_cursors(connection: &Connection) -> Result<(), RepositoryError> {
    let (event_epoch, head): (String, i64) = connection
        .query_row(
            "SELECT event_epoch, global_revision FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(storage)?;
    canonical_uuid(&event_epoch)?;
    let mut statement = connection
        .prepare(
            "SELECT event_epoch, revision, resync_required, updated_at
             FROM plugin_event_cursors ORDER BY plugin_id",
        )
        .map_err(storage)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(storage)?;
    for result in rows {
        let (cursor_epoch, revision, resync_required, updated_at) = result.map_err(storage)?;
        canonical_uuid(&cursor_epoch)?;
        canonical_timestamp(&updated_at)?;
        if revision < 0
            || revision > head
            || !strict_bool(resync_required)
            || (cursor_epoch != event_epoch && resync_required != 1)
        {
            return invalid("plugin event cursor");
        }
    }
    Ok(())
}

fn validate_invocations(
    connection: &Connection,
    plugins: &[LoadedPlugin],
) -> Result<(), RepositoryError> {
    if table_count(connection, "plugin_invocations")? > INVOCATIONS_PROFILE_MAX {
        return invalid("plugin invocation profile ceiling");
    }
    let mut statement = connection
        .prepare(
            "SELECT operation_id, plugin_id, package_generation, activation_epoch,
                    hook_kind, entry_id, request_hash, delivery_id, state, error_code,
                    created_at, updated_at, retain_until,
                    LENGTH(CAST(operation_id AS BLOB)) + LENGTH(CAST(plugin_id AS BLOB))
                      + LENGTH(CAST(hook_kind AS BLOB)) + LENGTH(CAST(entry_id AS BLOB))
                      + LENGTH(CAST(request_hash AS BLOB)) + LENGTH(CAST(delivery_id AS BLOB))
                      + LENGTH(CAST(state AS BLOB)) + COALESCE(LENGTH(CAST(error_code AS BLOB)), 0)
                      + LENGTH(CAST(created_at AS BLOB)) + LENGTH(CAST(updated_at AS BLOB))
                      + LENGTH(CAST(retain_until AS BLOB))
             FROM plugin_invocations ORDER BY plugin_id, operation_id",
        )
        .map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    let mut aggregates: BTreeMap<String, (i64, i64)> = BTreeMap::new();
    let mut total_bytes = 0_i64;
    while let Some(row) = rows.next().map_err(storage)? {
        let operation_id: String = row.get(0).map_err(storage)?;
        let plugin_id: String = row.get(1).map_err(storage)?;
        let package_generation: i64 = row.get(2).map_err(storage)?;
        let activation_epoch: i64 = row.get(3).map_err(storage)?;
        let hook_kind: String = row.get(4).map_err(storage)?;
        let entry_id: String = row.get(5).map_err(storage)?;
        let request_hash: String = row.get(6).map_err(storage)?;
        let delivery_id: String = row.get(7).map_err(storage)?;
        let state: String = row.get(8).map_err(storage)?;
        let error_code: Option<String> = row.get(9).map_err(storage)?;
        let created_at: String = row.get(10).map_err(storage)?;
        let updated_at: String = row.get(11).map_err(storage)?;
        let retain_until: String = row.get(12).map_err(storage)?;
        let material_bytes: i64 = row.get(13).map_err(storage)?;
        let plugin = plugin(plugins, &plugin_id)?;
        if package_generation != plugin.row.package_generation
            || activation_epoch <= 0
            || activation_epoch != plugin.row.activation_epoch
            || !matches!(
                state.as_str(),
                "reserved" | "dispatching_http" | "effect_committing" | "ambiguous_http"
            )
            || error_code
                .as_deref()
                .is_some_and(|code| !valid_error_code(code))
        {
            return invalid("plugin invocation fence");
        }
        canonical_operation_id(&operation_id)?;
        canonical_operation_id(&delivery_id)?;
        canonical_hash(&request_hash)?;
        validate_hook(plugin, &hook_kind, &entry_id)?;
        let created = canonical_timestamp(&created_at)?;
        let updated = canonical_timestamp(&updated_at)?;
        let retained = canonical_timestamp(&retain_until)?;
        if created > updated || updated > retained {
            return invalid("plugin invocation timestamp order");
        }
        let aggregate = aggregates.entry(plugin_id).or_default();
        aggregate.0 += 1;
        aggregate.1 = aggregate
            .1
            .checked_add(material_bytes)
            .ok_or_else(|| invalid_error("plugin invocation material"))?;
        total_bytes = total_bytes
            .checked_add(material_bytes)
            .ok_or_else(|| invalid_error("plugin invocation material"))?;
        if aggregate.0 > INVOCATIONS_PER_PLUGIN_MAX
            || aggregate.1 > INVOCATION_BYTES_PER_PLUGIN_MAX
            || total_bytes > INVOCATION_BYTES_PROFILE_MAX
        {
            return invalid("plugin invocation material ceiling");
        }
    }
    Ok(())
}

fn validate_hook(
    plugin: &LoadedPlugin,
    hook_kind: &str,
    entry_id: &str,
) -> Result<(), RepositoryError> {
    let found = match hook_kind {
        "invoke_command" => plugin
            .manifest
            .commands
            .iter()
            .any(|command| command.id == entry_id),
        "handle_event" => plugin.manifest.subscriptions.iter().any(|event| {
            serde_json::to_string(event)
                .ok()
                .and_then(|json| json.strip_prefix('"')?.strip_suffix('"').map(str::to_owned))
                .is_some_and(|id| id == entry_id)
        }),
        "handle_surface_action" => plugin
            .manifest
            .surfaces
            .iter()
            .any(|surface| surface.actions.iter().any(|action| action == entry_id)),
        "resync" => entry_id == "resync",
        _ => false,
    };
    if found {
        Ok(())
    } else {
        invalid("plugin invocation hook")
    }
}

fn plugin<'a>(
    plugins: &'a [LoadedPlugin],
    plugin_id: &str,
) -> Result<&'a LoadedPlugin, RepositoryError> {
    plugins
        .binary_search_by(|plugin| plugin.row.plugin_id.as_str().cmp(plugin_id))
        .map(|index| &plugins[index])
        .map_err(|_| invalid_error("plugin foreign authority"))
}

fn valid_error_code(code: &str) -> bool {
    let host_code = serde_json::from_str::<HostFailureCode>(&format!("\"{code}\""));
    host_code.is_ok()
        || matches!(
            code,
            "package_missing"
                | "package_invalid"
                | "signature_invalid"
                | "permission_denied"
                | "dependency_missing"
                | "dependency_incompatible"
                | "dependency_failed"
                | "host_unavailable"
                | "host_crashed"
                | "activation_failed"
                | "guest_trap"
                | "timeout"
                | "resource_limit"
                | "invalid_output"
                | "http_ambiguous"
                | "event_retention_lost"
                | "resync_failed"
                | "invocation_limit"
                | "internal_error"
        )
}

fn valid_kv_key(value: &str) -> bool {
    !value.chars().any(|character| {
        character.is_control()
            || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}

fn valid_setting_text(value: &str) -> bool {
    !value.chars().any(|character| {
        character == '\0'
            || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            || (character.is_control() && character != '\n' && character != '\t')
    })
}

fn parse_json<T: DeserializeOwned>(
    raw: &str,
    authority: &'static str,
) -> Result<T, RepositoryError> {
    serde_json::from_str(raw).map_err(|_| invalid_error(authority))
}

fn canonical_hash(raw: &str) -> Result<[u8; 32], RepositoryError> {
    let decoded = decode_sha256_hex(raw).map_err(|_| invalid_error("canonical SHA-256"))?;
    if hash_hex(&decoded) != raw {
        return invalid("canonical SHA-256");
    }
    Ok(decoded)
}

fn canonical_timestamp(raw: &str) -> Result<Timestamp, RepositoryError> {
    let timestamp = raw
        .parse::<Timestamp>()
        .map_err(|_| invalid_error("canonical timestamp"))?;
    if timestamp.to_string() != raw {
        return invalid("canonical timestamp");
    }
    Ok(timestamp)
}

fn canonical_uuid(raw: &str) -> Result<(), RepositoryError> {
    let parsed = TaskId::parse(raw).map_err(|_| invalid_error("canonical UUID"))?;
    if parsed.to_string() != raw {
        return invalid("canonical UUID");
    }
    Ok(())
}

fn canonical_operation_id(raw: &str) -> Result<(), RepositoryError> {
    let parsed = OperationId::parse(raw).map_err(|_| invalid_error("canonical operation ID"))?;
    if parsed.to_string() != raw {
        return invalid("canonical operation ID");
    }
    Ok(())
}

fn strict_bool(value: i64) -> bool {
    matches!(value, 0 | 1)
}

fn hash_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, RepositoryError> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(storage)
}

fn invalid<T>(authority: &'static str) -> Result<T, RepositoryError> {
    Err(invalid_error(authority))
}

fn invalid_error(authority: &'static str) -> RepositoryError {
    RepositoryError::Storage(format!("plugin authority invalid: {authority}"))
}

fn storage(error: impl ToString) -> RepositoryError {
    RepositoryError::Storage(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_plugin_sdk::{Publisher, RuntimeProfile, WitAuthority};
    use rusqlite::params;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct TempProfile(PathBuf);

    impl TempProfile {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "junban-plugin-validation-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempProfile {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn manifest() -> RuntimeManifest {
        RuntimeManifest {
            schema_version: 1,
            id: "test-plugin".into(),
            name: "Test plugin".into(),
            description: "Storage authority fixture".into(),
            version: "1.0.0".into(),
            publisher: Publisher {
                id: "test-publisher".into(),
                name: "Test Publisher".into(),
                key_id: "22".repeat(32),
            },
            license: "MIT".into(),
            junban_compatibility: "^0.1".into(),
            wit: WitAuthority {
                package: "junban:plugin".into(),
                world: "plugin".into(),
                version: "0.1.0".into(),
            },
            runtime_profile: RuntimeProfile::Typescript,
            component_sha256: "11".repeat(32),
            permissions: Vec::new(),
            dependencies: Vec::new(),
            commands: Vec::new(),
            subscriptions: Vec::new(),
            surfaces: Vec::new(),
            settings: Vec::new(),
            services: Vec::new(),
        }
    }

    fn seed_plugin(connection: &Connection) {
        let manifest = manifest();
        let manifest_json = String::from_utf8(manifest.canonical_bytes().unwrap()).unwrap();
        let permission_hash = hash_hex(&manifest.permission_hash().unwrap());
        connection
            .execute(
                "UPDATE plugin_profile_state
                 SET next_package_generation = 2, updated_at = '2026-08-04T12:00:00Z'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO plugins(
                    plugin_id, package_generation, activation_epoch, package_sha256,
                    component_sha256, publisher_key_id, version, manifest_json,
                    permission_hash, compatibility, desired_enabled, runtime_state,
                    failure_count, installed_at, updated_at
                 ) VALUES (?1, 1, 4, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 'active', 0, ?9, ?9)",
                params![
                    manifest.id,
                    "33".repeat(32),
                    manifest.component_sha256,
                    manifest.publisher.key_id,
                    manifest.version,
                    manifest_json,
                    permission_hash,
                    manifest.junban_compatibility,
                    "2026-08-04T12:00:00Z",
                ],
            )
            .unwrap();
    }

    fn fresh_connection(profile: &TempProfile) -> Connection {
        let mut connection = Connection::open(profile.0.join("junban.sqlite3")).unwrap();
        connection
            .pragma_update(None, "foreign_keys", true)
            .unwrap();
        crate::migration::migrate(&mut connection, &profile.0).unwrap();
        connection
    }

    #[test]
    fn valid_empty_and_installed_authority_passes_without_runtime_construction() {
        let profile = TempProfile::new();
        let connection = fresh_connection(&profile);
        validate_plugin_authority(&connection).unwrap();
        seed_plugin(&connection);
        validate_plugin_authority(&connection).unwrap();
    }

    #[test]
    fn malformed_manifest_allocator_and_kv_aggregate_fail_without_repair() {
        let profile = TempProfile::new();
        let connection = fresh_connection(&profile);
        seed_plugin(&connection);

        connection
            .execute(
                "UPDATE plugins SET manifest_json = manifest_json || ' '",
                [],
            )
            .unwrap();
        assert!(validate_plugin_authority(&connection).is_err());
        let retained: String = connection
            .query_row("SELECT manifest_json FROM plugins", [], |row| row.get(0))
            .unwrap();
        assert!(retained.ends_with(' '));

        connection
            .execute(
                "UPDATE plugins SET manifest_json = rtrim(manifest_json)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE plugin_profile_state SET next_package_generation = 1",
                [],
            )
            .unwrap();
        assert!(validate_plugin_authority(&connection).is_err());
        connection
            .execute(
                "UPDATE plugin_profile_state SET next_package_generation = 2",
                [],
            )
            .unwrap();

        let transaction = connection.unchecked_transaction().unwrap();
        for index in 0..=KV_KEYS_MAX {
            transaction
                .execute(
                    "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                     VALUES ('test-plugin', ?1, X'', '2026-08-04T12:00:00Z')",
                    [format!("key-{index:03}")],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        assert!(validate_plugin_authority(&connection).is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM plugin_kv", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, KV_KEYS_MAX + 1);
    }

    #[test]
    fn plugin_kv_requires_blob_storage_in_schema_and_semantic_validation() {
        let profile = TempProfile::new();
        let connection = fresh_connection(&profile);
        seed_plugin(&connection);

        let text_insert = connection.execute(
            "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
             VALUES ('test-plugin', 'text-value', 'within-bounds',
                '2026-08-04T12:00:00Z')",
            [],
        );
        assert!(text_insert.is_err());

        connection
            .pragma_update(None, "ignore_check_constraints", true)
            .unwrap();
        connection
            .execute(
                "INSERT INTO plugin_kv(plugin_id, key, value, updated_at)
                 VALUES ('test-plugin', 'text-value', 'within-bounds',
                    '2026-08-04T12:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .pragma_update(None, "ignore_check_constraints", false)
            .unwrap();

        assert!(validate_plugin_authority(&connection).is_err());
        let storage_class: String = connection
            .query_row(
                "SELECT typeof(value) FROM plugin_kv WHERE key = 'text-value'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(storage_class, "text");
    }

    #[test]
    fn hostile_trust_grant_setting_cursor_and_invocation_rows_fail_closed() {
        let profile = TempProfile::new();
        let connection = fresh_connection(&profile);
        seed_plugin(&connection);

        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_publisher_trust(
                    key_id, public_key, status, trusted_at
                 ) VALUES (?1, ?2, 'active', '2020-08-04T12:00:00Z')",
                params!["00".repeat(32), vec![1_u8; 32]],
            )
            .unwrap();
        assert!(validate_plugin_authority(&transaction).is_err());
        transaction.rollback().unwrap();

        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_grants(
                    plugin_id, package_generation, capability, scope_json, scope_hash,
                    permission_hash, granted_at
                 ) SELECT plugin_id, package_generation, 'storage', '{}', ?1,
                          permission_hash, '2020-08-04T12:00:00Z'
                   FROM plugins WHERE plugin_id = 'test-plugin'",
                ["00".repeat(32)],
            )
            .unwrap();
        assert!(validate_plugin_authority(&transaction).is_err());
        transaction.rollback().unwrap();

        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_settings(plugin_id, setting_key, value_json, updated_at)
                 VALUES ('test-plugin', 'undeclared', 'true', '2020-08-04T12:00:00Z')",
                [],
            )
            .unwrap();
        assert!(validate_plugin_authority(&transaction).is_err());
        transaction.rollback().unwrap();

        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_event_cursors(
                    plugin_id, event_epoch, revision, resync_required, updated_at
                 ) SELECT 'test-plugin', event_epoch, global_revision + 1, 0,
                          '2020-08-04T12:00:00Z'
                   FROM app_state WHERE singleton = 1",
                [],
            )
            .unwrap();
        assert!(validate_plugin_authority(&transaction).is_err());
        transaction.rollback().unwrap();

        let transaction = connection.unchecked_transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO plugin_invocations(
                    operation_id, plugin_id, package_generation, activation_epoch,
                    hook_kind, entry_id, request_hash, delivery_id, state,
                    created_at, updated_at, retain_until
                 ) VALUES (
                    '70000000-0000-7000-8000-000000000001', 'test-plugin', 1, 4,
                    'resync', 'not-resync', ?1,
                    '70000000-0000-7000-8000-000000000002', 'reserved',
                    '2020-08-04T12:00:00Z', '2020-08-04T12:00:00Z',
                    '2030-08-04T12:00:00Z'
                 )",
                ["00".repeat(32)],
            )
            .unwrap();
        assert!(validate_plugin_authority(&transaction).is_err());
        transaction.rollback().unwrap();

        connection
            .execute("UPDATE plugins SET updated_at = '2020-99-99T00:00:00Z'", [])
            .unwrap();
        assert!(validate_plugin_authority(&connection).is_err());
    }

    #[test]
    fn normal_open_rejects_malformed_plugin_rows_without_truncation() {
        let profile = TempProfile::new();
        {
            let owner = crate::ProfileOwner::open(&profile.0).unwrap();
            drop(owner);
        }
        let connection = Connection::open(profile.0.join("junban.sqlite3")).unwrap();
        seed_plugin(&connection);
        connection
            .execute(
                "UPDATE plugins SET manifest_json = manifest_json || ' '",
                [],
            )
            .unwrap();
        drop(connection);

        assert!(crate::ProfileOwner::open(&profile.0).is_err());
        let connection = Connection::open(profile.0.join("junban.sqlite3")).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM plugins", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
