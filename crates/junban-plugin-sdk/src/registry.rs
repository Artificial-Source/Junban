use std::fmt;
use std::marker::PhantomData;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::de::{self, Deserialize, Deserializer, SeqAccess, Visitor};
use serde::{Deserialize as DeserializeDerive, Serialize};

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
const REGISTRY_SEARCH_TAGS_MAX: usize = 32;
/// Closed Capability enum cardinality; requested_capabilities cannot exceed it.
const REQUESTED_CAPABILITIES_MAX: usize = 17;
const REGISTRY_DOMAIN: &[u8] = b"junban.plugin.registry.v1\0";

#[derive(Clone, Debug, DeserializeDerive, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub junban_version: String,
    pub generated_at: String,
    pub root_key_id: String,
    #[serde(deserialize_with = "deserialize_registry_entries")]
    pub entries: Vec<RegistryEntry>,
}

#[derive(Clone, Debug, DeserializeDerive, Eq, PartialEq, Serialize)]
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
    #[serde(deserialize_with = "deserialize_search_tags")]
    pub search_tags: Vec<String>,
    pub runtime_profile: RuntimeProfile,
    #[serde(deserialize_with = "deserialize_requested_capabilities")]
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
    let signature_bytes: &[u8; 64] = bytes[12 + index_len..expected]
        .try_into()
        .map_err(|_| SdkError::Truncated { format: "JRI1" })?;

    // Verify the domain-separated raw index hash before any JSON materialization.
    let index_hash = sha256(index_bytes);
    let mut message = Vec::with_capacity(REGISTRY_DOMAIN.len() + 32);
    message.extend_from_slice(REGISTRY_DOMAIN);
    message.extend_from_slice(&index_hash);
    let root = VerifyingKey::from_bytes(compiled_root_key).map_err(|_| SdkError::Signature)?;
    root.verify_strict(&message, &Signature::from_bytes(signature_bytes))
        .map_err(|_| SdkError::Signature)?;

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

fn deserialize_registry_entries<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<RegistryEntry>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, REGISTRY_ENTRIES_MAX)
}

fn deserialize_search_tags<'de, D>(deserializer: D) -> std::result::Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, REGISTRY_SEARCH_TAGS_MAX)
}

fn deserialize_requested_capabilities<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<Capability>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, REQUESTED_CAPABILITIES_MAX)
}

fn deserialize_bounded_vec<'de, T, D>(
    deserializer: D,
    max: usize,
) -> std::result::Result<Vec<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    struct BoundedVecVisitor<T> {
        max: usize,
        marker: PhantomData<T>,
    }

    impl<'de, T> Visitor<'de> for BoundedVecVisitor<T>
    where
        T: Deserialize<'de>,
    {
        type Value = Vec<T>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "a sequence with at most {} elements", self.max)
        }

        fn visit_seq<A>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            // Never trust attacker-declared length beyond the contract ceiling.
            if seq.size_hint().is_some_and(|hint| hint > self.max) {
                return Err(de::Error::invalid_length(
                    seq.size_hint().unwrap_or(self.max.saturating_add(1)),
                    &self,
                ));
            }
            let capacity = seq.size_hint().unwrap_or(0).min(self.max);
            let mut values = Vec::with_capacity(capacity);
            while let Some(value) = seq.next_element()? {
                if values.len() >= self.max {
                    return Err(de::Error::invalid_length(self.max.saturating_add(1), &self));
                }
                values.push(value);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_seq(BoundedVecVisitor {
        max,
        marker: PhantomData,
    })
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
        if entry.search_tags.len() > REGISTRY_SEARCH_TAGS_MAX {
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
        if entry.requested_capabilities.len() > REQUESTED_CAPABILITIES_MAX {
            return Err(SdkError::Registry {
                field: "requested_capabilities",
            });
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

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const ROOT_KEY_BYTES: [u8; 32] = [11; 32];

    fn root_key() -> SigningKey {
        SigningKey::from_bytes(&ROOT_KEY_BYTES)
    }

    fn root_key_id_hex(key: &SigningKey) -> String {
        hex(&sha256(&key.verifying_key().to_bytes()))
    }

    fn sign_index_bytes(index_bytes: &[u8], key: &SigningKey) -> Vec<u8> {
        let mut message = REGISTRY_DOMAIN.to_vec();
        message.extend_from_slice(&sha256(index_bytes));
        let signature = key.sign(&message).to_bytes();
        let mut envelope = JRI1_MAGIC.to_vec();
        envelope.extend_from_slice(&u32::try_from(index_bytes.len()).unwrap().to_be_bytes());
        envelope.extend_from_slice(index_bytes);
        envelope.extend_from_slice(&signature);
        envelope
    }

    fn minimal_entry_json(plugin_id: &str, package_sha: &str) -> String {
        format!(
            concat!(
                "{{",
                "\"plugin_id\":{plugin},",
                "\"version\":\"1.0.0\",",
                "\"package_sha256\":{sha},",
                "\"package_size\":1,",
                "\"publisher_key_id\":{sha},",
                "\"name\":\"n\",",
                "\"description\":\"\",",
                "\"author\":\"a\",",
                "\"license\":\"MIT\",",
                "\"search_tags\":[],",
                "\"runtime_profile\":\"typescript\",",
                "\"requested_capabilities\":[],",
                "\"filename\":{filename}",
                "}}"
            ),
            plugin = serde_json::to_string(plugin_id).unwrap(),
            sha = serde_json::to_string(package_sha).unwrap(),
            filename = serde_json::to_string(&format!("sha256/{package_sha}.jbp")).unwrap(),
        )
    }

    fn index_prefix(key: &SigningKey) -> String {
        format!(
            concat!(
                "{{",
                "\"schema_version\":1,",
                "\"junban_version\":\"0.1.0\",",
                "\"generated_at\":\"2026-08-04T00:00:00Z\",",
                "\"root_key_id\":{root},",
                "\"entries\":"
            ),
            root = serde_json::to_string(&root_key_id_hex(key)).unwrap(),
        )
    }

    #[test]
    fn unsigned_million_empty_search_tags_rejects_at_signature_before_json() {
        let key = root_key();
        // ~3 MB hostile corpus: one entry with 1_000_000 empty search_tags.
        let mut index = index_prefix(&key);
        index.push('[');
        index.push_str(&minimal_entry_json("p", &"ab".repeat(32)).replacen(
            "\"search_tags\":[]",
            &{
                let mut tags = String::from("\"search_tags\":[");
                for i in 0..1_000_000 {
                    if i > 0 {
                        tags.push(',');
                    }
                    tags.push_str("\"\"");
                }
                tags.push(']');
                tags
            },
            1,
        ));
        index.push_str("]}");
        assert!(index.len() > 2_000_000);
        assert!(index.len() <= REGISTRY_INDEX_BYTES_MAX);

        let mut envelope = JRI1_MAGIC.to_vec();
        envelope.extend_from_slice(&u32::try_from(index.len()).unwrap().to_be_bytes());
        envelope.extend_from_slice(index.as_bytes());
        envelope.extend_from_slice(&[0; 64]);

        assert!(
            envelope.len() <= REGISTRY_ENVELOPE_BYTES_MAX,
            "corpus must stay under the 4 MiB raw envelope cap"
        );
        assert!(matches!(
            parse_and_verify_registry(&envelope, &key.verifying_key().to_bytes()),
            Err(SdkError::Signature)
        ));
    }

    #[test]
    fn signed_entry_tag_and_capability_overbounds_reject_at_max_plus_one() {
        let key = root_key();
        let package_sha = "ab".repeat(32);

        // entries max+1
        let mut entries = String::from("[");
        for i in 0..=REGISTRY_ENTRIES_MAX {
            if i > 0 {
                entries.push(',');
            }
            let id = format!("p{i:04}");
            let mut sha_bytes = [0_u8; 32];
            sha_bytes[0] = (i / 256) as u8;
            sha_bytes[1] = (i % 256) as u8;
            let sha = hex(&sha_bytes);
            entries.push_str(&minimal_entry_json(&id, &sha));
        }
        entries.push(']');
        let mut index = index_prefix(&key);
        index.push_str(&entries);
        index.push('}');
        assert!(matches!(
            parse_and_verify_registry(
                &sign_index_bytes(index.as_bytes(), &key),
                &key.verifying_key().to_bytes()
            ),
            Err(SdkError::CanonicalJson)
        ));

        // search_tags max+1
        let mut tags = String::from("\"search_tags\":[");
        for i in 0..=REGISTRY_SEARCH_TAGS_MAX {
            if i > 0 {
                tags.push(',');
            }
            tags.push_str(&format!("\"t{i:02}\""));
        }
        tags.push(']');
        let entry =
            minimal_entry_json("plugin", &package_sha).replacen("\"search_tags\":[]", &tags, 1);
        let mut index = index_prefix(&key);
        index.push('[');
        index.push_str(&entry);
        index.push_str("]}");
        assert!(matches!(
            parse_and_verify_registry(
                &sign_index_bytes(index.as_bytes(), &key),
                &key.verifying_key().to_bytes()
            ),
            Err(SdkError::CanonicalJson)
        ));

        // requested_capabilities max+1 (closed capability count + 1)
        let mut caps = String::from("\"requested_capabilities\":[");
        let labels = [
            "tasks:read",
            "tasks:write",
            "projects:read",
            "projects:write",
            "tags:read",
            "tags:write",
            "events:subscribe",
            "settings",
            "storage",
            "commands",
            "ui:view",
            "ui:panel",
            "ui:status",
            "services:provide",
            "services:consume",
            "http",
            "logging",
            "tasks:read",
        ];
        assert_eq!(labels.len(), REQUESTED_CAPABILITIES_MAX + 1);
        for (i, label) in labels.iter().enumerate() {
            if i > 0 {
                caps.push(',');
            }
            caps.push('"');
            caps.push_str(label);
            caps.push('"');
        }
        caps.push(']');
        let entry = minimal_entry_json("plugin", &package_sha).replacen(
            "\"requested_capabilities\":[]",
            &caps,
            1,
        );
        let mut index = index_prefix(&key);
        index.push('[');
        index.push_str(&entry);
        index.push_str("]}");
        assert!(matches!(
            parse_and_verify_registry(
                &sign_index_bytes(index.as_bytes(), &key),
                &key.verifying_key().to_bytes()
            ),
            Err(SdkError::CanonicalJson)
        ));
    }

    #[test]
    fn signed_malformed_index_fails_without_panic() {
        let key = root_key();
        let mut index = index_prefix(&key);
        index.push_str("[{\"not\":\"an-entry\"}]}");
        assert!(matches!(
            parse_and_verify_registry(
                &sign_index_bytes(index.as_bytes(), &key),
                &key.verifying_key().to_bytes()
            ),
            Err(SdkError::CanonicalJson)
        ));
    }
}
