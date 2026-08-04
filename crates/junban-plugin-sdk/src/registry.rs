use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::{
    error::{Result, SdkError},
    manifest::{Capability, RuntimeProfile},
    package::VerifiedPackage,
    util::{decode_hex_32, hex, is_canonical_id, sha256, validate_sorted_unique, validate_visible},
};

pub const JRI1_MAGIC: &[u8; 8] = b"JUNBANR1";
pub const REGISTRY_INDEX_BYTES_MAX: usize = 4 * 1024 * 1024;
pub const REGISTRY_ENVELOPE_BYTES_MAX: usize = REGISTRY_INDEX_BYTES_MAX + 76;
pub const REGISTRY_ENTRIES_MAX: usize = 1_024;
const REGISTRY_DOMAIN: &[u8] = b"junban.plugin.registry.v1\0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub junban_version: String,
    pub generated_at: String,
    pub root_key_id: String,
    pub entries: Vec<RegistryEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryEntry {
    pub plugin_id: String,
    pub version: String,
    pub package_sha256: String,
    pub package_size: u64,
    pub publisher_key_id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    pub license: String,
    pub search_tags: Vec<String>,
    pub runtime_profile: RuntimeProfile,
    pub requested_capabilities: Vec<Capability>,
    pub filename: String,
}

#[derive(Clone, Debug)]
pub struct VerifiedRegistry {
    pub index: RegistryIndex,
    pub index_sha256: String,
}

pub fn parse_and_verify_registry(
    bytes: &[u8],
    compiled_root_key: &[u8; 32],
) -> Result<VerifiedRegistry> {
    if bytes.len() > REGISTRY_ENVELOPE_BYTES_MAX {
        return Err(SdkError::Length { field: "registry" });
    }
    if bytes.len() < 12 {
        return Err(SdkError::Truncated { format: "JRI1" });
    }
    if &bytes[..8] != JRI1_MAGIC {
        return Err(SdkError::Magic { format: "JRI1" });
    }
    let index_len = usize::try_from(u32::from_be_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| SdkError::Truncated { format: "JRI1" })?,
    ))
    .map_err(|_| SdkError::Length {
        field: "registry index",
    })?;
    if index_len == 0 || index_len > REGISTRY_INDEX_BYTES_MAX {
        return Err(SdkError::Length {
            field: "registry index",
        });
    }
    let expected = 12_usize
        .checked_add(index_len)
        .and_then(|value| value.checked_add(64))
        .ok_or(SdkError::Length { field: "registry" })?;
    if bytes.len() < expected {
        return Err(SdkError::Truncated { format: "JRI1" });
    }
    if bytes.len() != expected {
        return Err(SdkError::Trailing { format: "JRI1" });
    }
    let index_bytes = &bytes[12..12 + index_len];
    let index: RegistryIndex =
        serde_json::from_slice(index_bytes).map_err(|_| SdkError::CanonicalJson)?;
    validate_index(&index)?;
    if serde_json::to_vec(&index).map_err(|_| SdkError::CanonicalJson)? != index_bytes {
        return Err(SdkError::CanonicalJson);
    }
    let root_key_id = sha256(compiled_root_key);
    if decode_hex_32(&index.root_key_id, "root_key_id")? != root_key_id {
        return Err(SdkError::Registry {
            field: "root_key_id",
        });
    }
    let index_hash = sha256(index_bytes);
    let mut message = Vec::with_capacity(REGISTRY_DOMAIN.len() + 32);
    message.extend_from_slice(REGISTRY_DOMAIN);
    message.extend_from_slice(&index_hash);
    let root = VerifyingKey::from_bytes(compiled_root_key).map_err(|_| SdkError::Signature)?;
    let signature_bytes: &[u8; 64] = bytes[12 + index_len..expected]
        .try_into()
        .map_err(|_| SdkError::Truncated { format: "JRI1" })?;
    root.verify_strict(&message, &Signature::from_bytes(signature_bytes))
        .map_err(|_| SdkError::Signature)?;
    Ok(VerifiedRegistry {
        index,
        index_sha256: hex(&index_hash),
    })
}

pub fn validate_registry_package_agreement(
    entry: &RegistryEntry,
    package: &VerifiedPackage<'_>,
) -> Result<()> {
    let manifest = &package.manifest;
    let requested: Vec<Capability> = manifest
        .permissions
        .iter()
        .map(|permission| permission.capability)
        .collect();
    if entry.plugin_id != manifest.id
        || entry.version != manifest.version
        || entry.package_sha256 != package.identities.package_sha256
        || entry.package_size != package.identities.package_size
        || entry.publisher_key_id != package.identities.key_id
        || entry.name != manifest.name
        || entry.description != manifest.description
        || entry.author != manifest.publisher.name
        || entry.license != manifest.license
        || entry.runtime_profile != manifest.runtime_profile
        || entry.requested_capabilities != requested
        || entry.filename != registry_package_path(&entry.package_sha256)?
    {
        return Err(SdkError::Registry {
            field: "entry/package agreement",
        });
    }
    Ok(())
}

pub fn registry_package_path(package_sha256: &str) -> Result<String> {
    decode_hex_32(package_sha256, "package_sha256")?;
    Ok(format!("sha256/{package_sha256}.jbp"))
}

fn validate_index(index: &RegistryIndex) -> Result<()> {
    if index.schema_version != 1 {
        return Err(SdkError::Registry {
            field: "schema_version",
        });
    }
    canonical_version(&index.junban_version, "junban_version")?;
    canonical_timestamp(&index.generated_at)?;
    decode_hex_32(&index.root_key_id, "root_key_id")?;
    if index.entries.len() > REGISTRY_ENTRIES_MAX {
        return Err(SdkError::Length {
            field: "registry entries",
        });
    }
    let mut previous: Option<(&str, semver::Version)> = None;
    for entry in &index.entries {
        if !is_canonical_id(&entry.plugin_id) {
            return Err(SdkError::Registry { field: "plugin_id" });
        }
        let version = semver::Version::parse(&entry.version)
            .map_err(|_| SdkError::Registry { field: "version" })?;
        if version.to_string() != entry.version {
            return Err(SdkError::Registry { field: "version" });
        }
        if previous.as_ref().is_some_and(|(id, old_version)| {
            (*id, old_version) >= (entry.plugin_id.as_str(), &version)
        }) {
            return Err(SdkError::Order {
                field: "registry entries",
            });
        }
        decode_hex_32(&entry.package_sha256, "package_sha256")?;
        decode_hex_32(&entry.publisher_key_id, "publisher_key_id")?;
        if entry.package_size == 0 || entry.package_size > crate::package::PACKAGE_BYTES_MAX as u64
        {
            return Err(SdkError::Registry {
                field: "package_size",
            });
        }
        validate_visible(&entry.name, 1, 128, false, "registry.name")?;
        validate_visible(&entry.description, 0, 512, true, "registry.description")?;
        validate_visible(&entry.author, 1, 128, false, "registry.author")?;
        if entry.license.is_empty()
            || entry.license.len() > 128
            || !entry.license.is_ascii()
            || spdx::Expression::parse(&entry.license).is_err()
        {
            return Err(SdkError::Registry { field: "license" });
        }
        if entry.search_tags.len() > 32 {
            return Err(SdkError::Registry {
                field: "search_tags",
            });
        }
        validate_sorted_unique(&entry.search_tags, "search_tags")?;
        for tag in &entry.search_tags {
            if !is_canonical_id(tag) {
                return Err(SdkError::Registry {
                    field: "search_tags",
                });
            }
        }
        if entry
            .requested_capabilities
            .windows(2)
            .any(|pair| pair[0].as_str() >= pair[1].as_str())
        {
            return Err(SdkError::Order {
                field: "requested_capabilities",
            });
        }
        if entry.filename != registry_package_path(&entry.package_sha256)? {
            return Err(SdkError::Registry { field: "filename" });
        }
        previous = Some((&entry.plugin_id, version));
    }
    Ok(())
}

fn canonical_version(value: &str, field: &'static str) -> Result<()> {
    let parsed = semver::Version::parse(value).map_err(|_| SdkError::Registry { field })?;
    if parsed.to_string() != value {
        return Err(SdkError::Registry { field });
    }
    Ok(())
}

fn canonical_timestamp(value: &str) -> Result<()> {
    let parsed: jiff::Timestamp = value.parse().map_err(|_| SdkError::Registry {
        field: "generated_at",
    })?;
    if parsed.to_string() != value {
        return Err(SdkError::Registry {
            field: "generated_at",
        });
    }
    Ok(())
}
