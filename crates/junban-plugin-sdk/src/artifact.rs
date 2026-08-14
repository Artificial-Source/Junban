use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::path::Component;

use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    COMPONENT_BYTES_MAX, MANIFEST_BYTES_MAX, PACKAGE_BYTES_MAX, REGISTRY_ENTRIES_MAX,
    REGISTRY_ENVELOPE_BYTES_MAX, RegistryEntry, RegistryIndex, RuntimeManifest, SdkError,
    SourceManifest, WIT_SOURCE, inspect_component, pack_package, pack_registry,
    parse_and_verify_registry, parse_package, registry_entry_from_verified_package,
    util::{hex, is_canonical_id, sha256},
    validate_signer_public_key, verify_package,
};

const REGISTRY_METADATA_BYTES_MAX: usize = crate::REGISTRY_INDEX_BYTES_MAX;
const REFERENCE_PROVENANCE_BYTES_MAX: usize = 64 * 1024;
const REFERENCE_WIT_BYTES_MAX: usize = 64 * 1024;
const INCLUDE_TABLE_BYTES_MAX: usize = 1024 * 1024;
const REGISTRY_SEARCH_TAGS_MAX: usize = 32;
const TYPESCRIPT_NODE_VERSION: &str = "24.13.1";
const TYPESCRIPT_NPM_VERSION: &str = "11.18.0";
const TYPESCRIPT_VERSION: &str = "6.0.3";
const TYPESCRIPT_JCO_VERSION: &str = "1.26.1";
const TYPESCRIPT_COMPONENTIZE_JS_VERSION: &str = "0.22.0";

/// Stable, path-free failures emitted by permanent artifact construction tools.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ArtifactError {
    #[error("artifact input is unavailable")]
    InputUnavailable,
    #[error("artifact input exceeds its admitted bound")]
    InputTooLarge,
    #[error("signing key is unavailable")]
    KeyUnavailable,
    #[error("signing key location or metadata is unsafe")]
    KeyUnsafe,
    #[error("signing key must contain exactly one raw 32-byte Ed25519 seed")]
    KeyLength,
    #[error(
        "signing is unavailable because owner-only key ACL validation is not implemented on this platform"
    )]
    KeyPlatformUnsupported,
    #[error("artifact output already exists; refusing to overwrite it")]
    OutputExists,
    #[error("artifact output could not be created")]
    OutputUnavailable,
    #[error("artifact output was published but publication durability could not be confirmed")]
    OutputDurability,
    #[error("artifact inputs do not describe the same package authority")]
    AuthorityMismatch,
    #[error("registry source metadata is invalid")]
    MetadataInvalid,
    #[error("registry package directory authority is invalid")]
    PackageDirectory,
    #[error("registry reference source authority is invalid")]
    ReferenceMismatch,
    #[error("generated registry include table differs from verified authority")]
    IncludeDrift,
    #[error("registry publication stopped after publishing only one complete output")]
    PartialPublication,
    #[error(transparent)]
    Sdk(#[from] SdkError),
}

/// Typed author-controlled presentation metadata for one JRI1 index.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrySourceMetadata {
    pub schema_version: u32,
    pub generated_at: String,
    #[serde(deserialize_with = "deserialize_metadata_entries")]
    pub entries: Vec<RegistrySourceEntry>,
}

/// Presentation metadata for exactly one verified package identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrySourceEntry {
    pub plugin_id: String,
    pub version: String,
    #[serde(deserialize_with = "deserialize_metadata_search_tags")]
    pub search_tags: Vec<String>,
}

/// Checked source-side build authority required for each retained Rust reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RustReferenceAuthority {
    pub schema_version: u32,
    pub artifact: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub source_wit_sha256: String,
    pub world_wit_sha256: String,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub reproducibility: String,
}

/// Exact checked provenance contract for a retained TypeScript component.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeScriptComponentProvenance {
    pub schema_version: u32,
    pub artifact: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub source_wit_sha256: String,
    pub world_wit_sha256: String,
    pub node: String,
    pub npm: String,
    pub typescript: String,
    pub jco: String,
    pub componentize_js: String,
    pub wasi: String,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    pub reproducibility: String,
}

impl RegistrySourceMetadata {
    /// Parse and validate bounded registry source metadata.
    pub fn parse(bytes: &[u8]) -> Result<Self, ArtifactError> {
        if bytes.is_empty() || bytes.len() > REGISTRY_METADATA_BYTES_MAX {
            return Err(ArtifactError::MetadataInvalid);
        }
        let metadata: Self =
            serde_json::from_slice(bytes).map_err(|_| ArtifactError::MetadataInvalid)?;
        metadata.validate()?;
        Ok(metadata)
    }

    /// Validate schema, timestamp, entry ordering, identities, and search tags.
    pub fn validate(&self) -> Result<(), ArtifactError> {
        if self.schema_version != 1 || self.entries.len() > REGISTRY_ENTRIES_MAX {
            return Err(ArtifactError::MetadataInvalid);
        }
        let timestamp: jiff::Timestamp = self
            .generated_at
            .parse()
            .map_err(|_| ArtifactError::MetadataInvalid)?;
        if timestamp.to_string() != self.generated_at {
            return Err(ArtifactError::MetadataInvalid);
        }
        let mut previous: Option<(&str, semver::Version)> = None;
        for entry in &self.entries {
            if !is_canonical_id(&entry.plugin_id) {
                return Err(ArtifactError::MetadataInvalid);
            }
            let version = semver::Version::parse(&entry.version)
                .map_err(|_| ArtifactError::MetadataInvalid)?;
            if version.to_string() != entry.version
                || previous.as_ref().is_some_and(|(plugin_id, old_version)| {
                    (*plugin_id, old_version) >= (entry.plugin_id.as_str(), &version)
                })
            {
                return Err(ArtifactError::MetadataInvalid);
            }
            if entry.search_tags.len() > REGISTRY_SEARCH_TAGS_MAX
                || entry.search_tags.windows(2).any(|pair| pair[0] >= pair[1])
                || entry.search_tags.iter().any(|tag| !is_canonical_id(tag))
            {
                return Err(ArtifactError::MetadataInvalid);
            }
            previous = Some((&entry.plugin_id, version));
        }
        Ok(())
    }
}

fn deserialize_metadata_entries<'de, D>(
    deserializer: D,
) -> Result<Vec<RegistrySourceEntry>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, REGISTRY_ENTRIES_MAX)
}

fn deserialize_metadata_search_tags<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    deserialize_bounded_vec(deserializer, REGISTRY_SEARCH_TAGS_MAX)
}

fn deserialize_bounded_vec<'de, T, D>(deserializer: D, max: usize) -> Result<Vec<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    use serde::de::{Error as _, Visitor};
    use std::{fmt, marker::PhantomData};

    struct BoundedVisitor<T> {
        max: usize,
        marker: PhantomData<T>,
    }

    impl<'de, T: Deserialize<'de>> Visitor<'de> for BoundedVisitor<T> {
        type Value = Vec<T>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(formatter, "at most {} entries", self.max)
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            if sequence.size_hint().is_some_and(|hint| hint > self.max) {
                return Err(A::Error::invalid_length(
                    sequence.size_hint().unwrap_or(self.max + 1),
                    &self,
                ));
            }
            let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.max));
            while let Some(value) = sequence.next_element()? {
                if values.len() == self.max {
                    return Err(A::Error::invalid_length(self.max + 1, &self));
                }
                values.push(value);
            }
            Ok(values)
        }
    }

    deserializer.deserialize_seq(BoundedVisitor {
        max,
        marker: PhantomData,
    })
}

/// Parse and validate one bounded author source-manifest file.
pub fn check_source_manifest(path: &Path) -> Result<SourceManifest, ArtifactError> {
    SourceManifest::parse(&read_bounded(path, MANIFEST_BYTES_MAX)?).map_err(ArtifactError::from)
}

/// Derive, validate, and no-replace publish the exact 32-byte Ed25519 public
/// key for one externally held signing seed.
///
/// `key_path` must name an external raw, exact 32-byte Ed25519 seed file that
/// passes the platform key-location and owner-private metadata policy.
pub fn publish_signing_public_key(
    key_path: &Path,
    output_path: &Path,
) -> Result<(), ArtifactError> {
    require_output_absent(output_path)?;
    let public_key = {
        let signing_key = read_signing_key(key_path)?;
        signing_key.verifying_key().to_bytes()
    };
    validate_public_key_bytes(&public_key)?;
    write_new_public_key_output(output_path, &public_key)?;
    if read_public_key(output_path)? != public_key {
        return Err(ArtifactError::AuthorityMismatch);
    }
    Ok(())
}

/// Inspect, derive, sign, and immediately public-verify one JBP1 package, then
/// publish it to a new output file without overwriting an existing artifact.
///
/// `key_path` must name an external raw, exact 32-byte Ed25519 seed file that
/// passes the platform key-location and owner-private metadata policy.
pub fn sign_package_artifact(
    source_path: &Path,
    component_path: &Path,
    key_path: &Path,
    output_path: &Path,
) -> Result<(), ArtifactError> {
    let source = check_source_manifest(source_path)?;
    let component = read_bounded(component_path, COMPONENT_BYTES_MAX)?;
    let signing_key = read_signing_key(key_path)?;
    let public_key = signing_key.verifying_key().to_bytes();
    let runtime = source.derive_runtime_manifest(&component, &public_key)?;
    inspect_component(&component, &runtime)?;
    let package_bytes = pack_package(&runtime, &component, &signing_key)?;
    let verified = verify_package(&package_bytes)?;
    let parsed = parse_package(&package_bytes)?;
    require_package_match(
        &runtime,
        &component,
        &public_key,
        &verified.manifest,
        verified.component_bytes,
        parsed.public_key,
    )?;
    write_new_output(output_path, &package_bytes)
}

/// Public-only verify one JBP1 file against exact source-manifest and component
/// inputs. The publisher public key is read only from the signed package.
pub fn verify_package_artifact(
    source_path: &Path,
    component_path: &Path,
    package_path: &Path,
) -> Result<(), ArtifactError> {
    let source = check_source_manifest(source_path)?;
    let component = read_bounded(component_path, COMPONENT_BYTES_MAX)?;
    let package_bytes = read_bounded(package_path, PACKAGE_BYTES_MAX)?;
    let verified = verify_package(&package_bytes)?;
    let parsed = parse_package(&package_bytes)?;
    let expected = source.derive_runtime_manifest(&component, parsed.public_key)?;
    require_package_match(
        &expected,
        &component,
        parsed.public_key,
        &verified.manifest,
        verified.component_bytes,
        parsed.public_key,
    )?;
    inspect_component(&component, &expected)?;
    Ok(())
}

/// Build, sign, immediately public-verify, and no-replace publish one JRI1
/// index and its exact 32-byte root public key.
pub fn sign_registry_index(
    packages_dir: &Path,
    metadata_path: &Path,
    publisher_public_key_path: &Path,
    key_path: &Path,
    root_public_key_output: &Path,
    index_output: &Path,
) -> Result<(), ArtifactError> {
    if root_public_key_output == index_output {
        return Err(ArtifactError::OutputUnavailable);
    }
    require_output_absent(root_public_key_output)?;
    require_output_absent(index_output)?;

    let metadata =
        RegistrySourceMetadata::parse(&read_bounded(metadata_path, REGISTRY_METADATA_BYTES_MAX)?)?;
    let publisher_public_key = read_public_key(publisher_public_key_path)?;
    let packages = scan_package_directory(packages_dir)?;
    require_publisher_authority(&packages, &publisher_public_key)?;

    // The root private key is deliberately read only after every package and
    // publisher-authority preflight has passed. No root signature is formed for
    // a mixed-publisher or otherwise invalid package set.
    let signing_key = read_signing_key(key_path)?;
    let root_public_key = signing_key.verifying_key().to_bytes();
    let index = build_registry_index(&metadata, &packages, &root_public_key)?;
    let index_bytes = pack_registry(&index, &signing_key)?;

    let verified = parse_and_verify_registry(&index_bytes, &root_public_key)?;
    require_index_package_agreement(verified.index(), &packages)?;
    let current_packages = scan_package_directory(packages_dir)?;
    require_publisher_authority(&current_packages, &publisher_public_key)?;
    require_index_package_agreement(verified.index(), &current_packages)?;

    // Publish the public key first. A public key without an index grants no
    // package authority. If the second no-replace publication loses a race,
    // retain the complete first output: portable std has no conditional unlink
    // operation that can prove it would not delete a racing replacement.
    write_new_output(root_public_key_output, &root_public_key)?;
    if write_new_output(index_output, &index_bytes).is_err() {
        return Err(ArtifactError::PartialPublication);
    }
    Ok(())
}

/// Publicly verify registry authority and generate the exact product include
/// module. Check mode exact-compares an existing file without writing.
pub fn write_registry_include_table(
    root_public_key_path: &Path,
    publisher_public_key_path: &Path,
    index_path: &Path,
    packages_dir: &Path,
    output_path: &Path,
    check: bool,
) -> Result<(), ArtifactError> {
    let (_, packages) = verify_registry_files(
        root_public_key_path,
        publisher_public_key_path,
        index_path,
        packages_dir,
    )?;
    let expected = generate_include_table(&packages);
    if expected.len() > INCLUDE_TABLE_BYTES_MAX {
        return Err(ArtifactError::InputTooLarge);
    }
    if check {
        let actual = read_bounded(output_path, INCLUDE_TABLE_BYTES_MAX)?;
        if actual != expected.as_bytes() {
            return Err(ArtifactError::IncludeDrift);
        }
        return Ok(());
    }
    write_new_output(output_path, expected.as_bytes())
}

/// Permanent public-only verification of signed registry artifacts, retained
/// reference sources/components/WIT, and the generated include module.
pub fn verify_registry_references(
    references_dir: &Path,
    metadata_path: &Path,
    root_public_key_path: &Path,
    publisher_public_key_path: &Path,
    index_path: &Path,
    packages_dir: &Path,
    include_table_path: &Path,
) -> Result<(), ArtifactError> {
    let metadata =
        RegistrySourceMetadata::parse(&read_bounded(metadata_path, REGISTRY_METADATA_BYTES_MAX)?)?;
    let (index, packages) = verify_registry_files(
        root_public_key_path,
        publisher_public_key_path,
        index_path,
        packages_dir,
    )?;
    require_registry_metadata_agreement(&metadata, &index)?;
    let references = scan_reference_directories(references_dir)?;
    if references.len() != index.entries.len() {
        return Err(ArtifactError::ReferenceMismatch);
    }

    let mut seen_plugins = BTreeSet::new();
    for entry in &index.entries {
        if !seen_plugins.insert(entry.plugin_id.as_str()) {
            return Err(ArtifactError::ReferenceMismatch);
        }
        let reference = references
            .get(&entry.plugin_id)
            .ok_or(ArtifactError::ReferenceMismatch)?;
        let package = packages
            .iter()
            .find(|package| package.digest == entry.package_sha256)
            .ok_or(ArtifactError::AuthorityMismatch)?;
        verify_reference(entry, reference, package)?;
    }

    let expected = generate_include_table(&packages);
    let actual = read_bounded(include_table_path, INCLUDE_TABLE_BYTES_MAX)?;
    if actual != expected.as_bytes() {
        return Err(ArtifactError::IncludeDrift);
    }
    Ok(())
}

#[derive(Debug)]
struct PackageRecord {
    path: PathBuf,
    digest: String,
    publisher_public_key: [u8; 32],
    derived_entry: RegistryEntry,
}

fn require_registry_metadata_agreement(
    metadata: &RegistrySourceMetadata,
    index: &RegistryIndex,
) -> Result<(), ArtifactError> {
    if metadata.generated_at != index.generated_at
        || metadata.entries.len() != index.entries.len()
        || metadata
            .entries
            .iter()
            .zip(&index.entries)
            .any(|(source, entry)| {
                source.plugin_id != entry.plugin_id
                    || source.version != entry.version
                    || source.search_tags != entry.search_tags
            })
    {
        return Err(ArtifactError::AuthorityMismatch);
    }
    Ok(())
}

fn build_registry_index(
    metadata: &RegistrySourceMetadata,
    packages: &[PackageRecord],
    root_public_key: &[u8; 32],
) -> Result<RegistryIndex, ArtifactError> {
    if metadata.entries.len() != packages.len() {
        return Err(ArtifactError::AuthorityMismatch);
    }
    let mut package_by_identity = BTreeMap::new();
    for package in packages {
        let key = (
            package.derived_entry.plugin_id.as_str(),
            package.derived_entry.version.as_str(),
        );
        if package_by_identity.insert(key, package).is_some() {
            return Err(ArtifactError::AuthorityMismatch);
        }
    }

    let mut entries = Vec::with_capacity(metadata.entries.len());
    for source in &metadata.entries {
        let package = package_by_identity
            .get(&(source.plugin_id.as_str(), source.version.as_str()))
            .ok_or(ArtifactError::AuthorityMismatch)?;
        let mut entry = package.derived_entry.clone();
        entry.search_tags.clone_from(&source.search_tags);
        entries.push(entry);
    }
    let index = RegistryIndex {
        schema_version: 1,
        junban_version: env!("CARGO_PKG_VERSION").to_owned(),
        generated_at: metadata.generated_at.clone(),
        root_key_id: hex(&sha256(root_public_key)),
        entries,
    };
    index.validate()?;
    require_index_package_agreement(&index, packages)?;
    Ok(index)
}

fn verify_registry_files(
    root_public_key_path: &Path,
    publisher_public_key_path: &Path,
    index_path: &Path,
    packages_dir: &Path,
) -> Result<(RegistryIndex, Vec<PackageRecord>), ArtifactError> {
    let root_public_key = read_public_key(root_public_key_path)?;
    let publisher_public_key = read_public_key(publisher_public_key_path)?;
    let index_bytes = read_bounded(index_path, REGISTRY_ENVELOPE_BYTES_MAX)?;
    let registry = parse_and_verify_registry(&index_bytes, &root_public_key)?;
    if registry.index().junban_version != env!("CARGO_PKG_VERSION") {
        return Err(ArtifactError::AuthorityMismatch);
    }
    let packages = scan_package_directory(packages_dir)?;
    require_publisher_authority(&packages, &publisher_public_key)?;
    require_index_package_agreement(registry.index(), &packages)?;
    Ok((registry.index().clone(), packages))
}

fn read_public_key(path: &Path) -> Result<[u8; 32], ArtifactError> {
    let bytes = read_bounded(path, 32)?;
    let public_key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ArtifactError::AuthorityMismatch)?;
    validate_public_key_bytes(&public_key)?;
    Ok(public_key)
}

fn validate_public_key_bytes(public_key: &[u8; 32]) -> Result<(), ArtifactError> {
    let verifying_key =
        VerifyingKey::from_bytes(public_key).map_err(|_| ArtifactError::AuthorityMismatch)?;
    if verifying_key.to_bytes() != *public_key {
        return Err(ArtifactError::AuthorityMismatch);
    }
    validate_signer_public_key(public_key)?;
    Ok(())
}

fn scan_package_directory(path: &Path) -> Result<Vec<PackageRecord>, ArtifactError> {
    require_directory(path).map_err(|_| ArtifactError::PackageDirectory)?;
    let entries = fs::read_dir(path).map_err(|_| ArtifactError::PackageDirectory)?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| ArtifactError::PackageDirectory)?;
        let file_name = entry
            .file_name()
            .into_string()
            .map_err(|_| ArtifactError::PackageDirectory)?;
        if !is_package_filename(&file_name) {
            return Err(ArtifactError::PackageDirectory);
        }
        let metadata = entry
            .metadata()
            .map_err(|_| ArtifactError::PackageDirectory)?;
        let supplied =
            fs::symlink_metadata(entry.path()).map_err(|_| ArtifactError::PackageDirectory)?;
        if !regular_metadata_is_safe(&supplied)
            || !regular_metadata_is_safe(&metadata)
            || metadata.len() == 0
            || metadata.len() > PACKAGE_BYTES_MAX as u64
        {
            return Err(ArtifactError::PackageDirectory);
        }
        files.push((file_name, entry.path()));
        if files.len() > REGISTRY_ENTRIES_MAX {
            return Err(ArtifactError::PackageDirectory);
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut packages = Vec::with_capacity(files.len());
    let mut identities = BTreeSet::new();
    for (file_name, file_path) in files {
        let package_bytes = read_bounded(&file_path, PACKAGE_BYTES_MAX)
            .map_err(|_| ArtifactError::PackageDirectory)?;
        let verified =
            verify_package(&package_bytes).map_err(|_| ArtifactError::PackageDirectory)?;
        let publisher_public_key = *parse_package(&package_bytes)
            .map_err(|_| ArtifactError::PackageDirectory)?
            .public_key;
        let digest = file_name
            .strip_suffix(".jbp")
            .ok_or(ArtifactError::PackageDirectory)?;
        if digest != verified.identities.package_sha256 {
            return Err(ArtifactError::PackageDirectory);
        }
        let derived_entry = registry_entry_from_verified_package(&verified, Vec::new())
            .map_err(|_| ArtifactError::PackageDirectory)?;
        if !identities.insert((
            derived_entry.plugin_id.clone(),
            derived_entry.version.clone(),
        )) {
            return Err(ArtifactError::PackageDirectory);
        }
        packages.push(PackageRecord {
            path: file_path,
            digest: digest.to_owned(),
            publisher_public_key,
            derived_entry,
        });
    }
    Ok(packages)
}

fn is_package_filename(file_name: &str) -> bool {
    let Some(digest) = file_name.strip_suffix(".jbp") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn require_publisher_authority(
    packages: &[PackageRecord],
    publisher_public_key: &[u8; 32],
) -> Result<(), ArtifactError> {
    let expected_key_id = hex(&sha256(publisher_public_key));
    if packages.iter().any(|package| {
        package.publisher_public_key != *publisher_public_key
            || package.derived_entry.publisher_key_id != expected_key_id
    }) {
        return Err(ArtifactError::AuthorityMismatch);
    }
    Ok(())
}

fn require_index_package_agreement(
    index: &RegistryIndex,
    packages: &[PackageRecord],
) -> Result<(), ArtifactError> {
    if index.entries.len() != packages.len() {
        return Err(ArtifactError::AuthorityMismatch);
    }
    let mut seen = BTreeSet::new();
    for entry in &index.entries {
        let package = packages
            .iter()
            .find(|package| package.digest == entry.package_sha256)
            .ok_or(ArtifactError::AuthorityMismatch)?;
        let mut expected = package.derived_entry.clone();
        expected.search_tags.clone_from(&entry.search_tags);
        if &expected != entry || !seen.insert(package.digest.as_str()) {
            return Err(ArtifactError::AuthorityMismatch);
        }
    }
    if seen.len() != packages.len() {
        return Err(ArtifactError::AuthorityMismatch);
    }
    Ok(())
}

fn generate_include_table(packages: &[PackageRecord]) -> String {
    let mut entries: Vec<_> = packages
        .iter()
        .map(|package| package.derived_entry.filename.as_str())
        .collect();
    entries.sort_unstable();
    let mut output = String::from(
        "// @generated by junban-plugin-artifact registry include-table; do not edit.\n\
         pub(super) const BUNDLED_REGISTRY_PACKAGES: &[(&str, &[u8])] = &[\n",
    );
    for filename in entries {
        output.push_str("    (\n        \"");
        output.push_str(filename);
        output.push_str("\",\n        include_bytes!(\"../../../plugins/registry/");
        output.push_str(filename);
        output.push_str("\"),\n    ),\n");
    }
    output.push_str("];\n");
    output
}

#[derive(Debug)]
struct ReferenceRecord {
    path: PathBuf,
    source: SourceManifest,
}

fn scan_reference_directories(
    path: &Path,
) -> Result<BTreeMap<String, ReferenceRecord>, ArtifactError> {
    require_directory(path).map_err(|_| ArtifactError::ReferenceMismatch)?;
    let mut references = BTreeMap::new();
    for entry in fs::read_dir(path).map_err(|_| ArtifactError::ReferenceMismatch)? {
        let entry = entry.map_err(|_| ArtifactError::ReferenceMismatch)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| ArtifactError::ReferenceMismatch)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| ArtifactError::ReferenceMismatch)?;
        if !directory_metadata_is_safe(&metadata)
            || !is_canonical_id(&name)
            || references.len() >= REGISTRY_ENTRIES_MAX
        {
            return Err(ArtifactError::ReferenceMismatch);
        }
        let source = check_source_manifest(&path.join("plugin-source.json"))
            .map_err(|_| ArtifactError::ReferenceMismatch)?;
        if references
            .insert(source.id.clone(), ReferenceRecord { path, source })
            .is_some()
        {
            return Err(ArtifactError::ReferenceMismatch);
        }
    }
    Ok(references)
}

fn verify_reference(
    entry: &RegistryEntry,
    reference: &ReferenceRecord,
    package: &PackageRecord,
) -> Result<(), ArtifactError> {
    let ReferenceRecord { path, source } = reference;
    let artifact_name = format!("{}.wasm", entry.plugin_id);
    let component_path = path.join("artifacts").join(&artifact_name);
    let wit_root = path.join("wit");
    let world_path = wit_root.join("world.wit");
    let dependency_wit_path = wit_root.join("deps/junban-plugin/plugin.wit");

    require_exact_directory(&path.join("artifacts"), &[(artifact_name.as_str(), false)])?;
    require_exact_directory(&wit_root, &[("deps", true), ("world.wit", false)])?;
    require_exact_directory(&wit_root.join("deps"), &[("junban-plugin", true)])?;
    require_exact_directory(
        &wit_root.join("deps/junban-plugin"),
        &[("plugin.wit", false)],
    )?;

    if source.id != entry.plugin_id || source.version != entry.version {
        return Err(ArtifactError::ReferenceMismatch);
    }
    let component = read_bounded(&component_path, COMPONENT_BYTES_MAX)
        .map_err(|_| ArtifactError::ReferenceMismatch)?;
    let package_bytes = read_bounded(&package.path, PACKAGE_BYTES_MAX)
        .map_err(|_| ArtifactError::ReferenceMismatch)?;
    let verified = verify_package(&package_bytes).map_err(|_| ArtifactError::ReferenceMismatch)?;
    let parsed = parse_package(&package_bytes).map_err(|_| ArtifactError::ReferenceMismatch)?;
    let mut current_entry = registry_entry_from_verified_package(&verified, Vec::new())
        .map_err(|_| ArtifactError::ReferenceMismatch)?;
    current_entry.search_tags.clone_from(&entry.search_tags);
    if verified.identities.package_sha256 != package.digest || &current_entry != entry {
        return Err(ArtifactError::ReferenceMismatch);
    }
    let expected = source
        .derive_runtime_manifest(&component, parsed.public_key)
        .map_err(|_| ArtifactError::ReferenceMismatch)?;
    require_package_match(
        &expected,
        &component,
        parsed.public_key,
        &verified.manifest,
        verified.component_bytes,
        parsed.public_key,
    )
    .map_err(|_| ArtifactError::ReferenceMismatch)?;
    let inspection =
        inspect_component(&component, &expected).map_err(|_| ArtifactError::ReferenceMismatch)?;

    let dependency_wit = read_bounded(&dependency_wit_path, WIT_SOURCE.len())
        .map_err(|_| ArtifactError::ReferenceMismatch)?;
    if dependency_wit != WIT_SOURCE.as_bytes() {
        return Err(ArtifactError::ReferenceMismatch);
    }
    let world_wit = read_bounded(&world_path, REFERENCE_WIT_BYTES_MAX)
        .map_err(|_| ArtifactError::ReferenceMismatch)?;
    if world_wit.is_empty() {
        return Err(ArtifactError::ReferenceMismatch);
    }

    let artifact = format!("artifacts/{artifact_name}");
    let component_sha256 = hex(&sha256(&component));
    let source_wit_sha256 = hex(&sha256(WIT_SOURCE.as_bytes()));
    let world_wit_sha256 = hex(&sha256(&world_wit));
    match source.runtime_profile {
        crate::RuntimeProfile::Rust => verify_rust_reference_authority(
            path,
            &artifact,
            &component,
            &component_sha256,
            &source_wit_sha256,
            &world_wit_sha256,
            &inspection,
        ),
        crate::RuntimeProfile::Typescript => verify_typescript_component_provenance(
            path,
            &artifact,
            &component,
            &component_sha256,
            &source_wit_sha256,
            &world_wit_sha256,
            &inspection,
        ),
    }
}

fn require_exact_directory(path: &Path, expected: &[(&str, bool)]) -> Result<(), ArtifactError> {
    require_directory(path).map_err(|_| ArtifactError::ReferenceMismatch)?;
    let mut actual = BTreeMap::new();
    for entry in fs::read_dir(path).map_err(|_| ArtifactError::ReferenceMismatch)? {
        let entry = entry.map_err(|_| ArtifactError::ReferenceMismatch)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| ArtifactError::ReferenceMismatch)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| ArtifactError::ReferenceMismatch)?;
        let kind_is_valid = expected
            .iter()
            .find(|(expected_name, _)| *expected_name == name)
            .is_some_and(|(_, directory)| {
                if *directory {
                    directory_metadata_is_safe(&metadata)
                } else {
                    regular_metadata_is_safe(&metadata)
                }
            });
        if !kind_is_valid || actual.insert(name, ()).is_some() {
            return Err(ArtifactError::ReferenceMismatch);
        }
    }
    if actual.len() != expected.len()
        || expected
            .iter()
            .any(|(expected_name, _)| !actual.contains_key(*expected_name))
    {
        return Err(ArtifactError::ReferenceMismatch);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn verify_rust_reference_authority(
    reference: &Path,
    artifact: &str,
    component: &[u8],
    component_sha256: &str,
    source_wit_sha256: &str,
    world_wit_sha256: &str,
    inspection: &crate::ComponentInspection,
) -> Result<(), ArtifactError> {
    let bytes = read_bounded(
        &reference.join("reference-authority.json"),
        REFERENCE_PROVENANCE_BYTES_MAX,
    )
    .map_err(|_| ArtifactError::ReferenceMismatch)?;
    let authority: RustReferenceAuthority =
        serde_json::from_slice(&bytes).map_err(|_| ArtifactError::ReferenceMismatch)?;
    if authority.schema_version != 1
        || authority.artifact != artifact
        || authority.size_bytes != component.len() as u64
        || authority.sha256 != component_sha256
        || authority.source_wit_sha256 != source_wit_sha256
        || authority.world_wit_sha256 != world_wit_sha256
        || authority.imports != inspection.imports
        || authority.exports != inspection.exports
        || authority.reproducibility != "byte-for-byte"
    {
        return Err(ArtifactError::ReferenceMismatch);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn verify_typescript_component_provenance(
    reference: &Path,
    artifact: &str,
    component: &[u8],
    component_sha256: &str,
    source_wit_sha256: &str,
    world_wit_sha256: &str,
    inspection: &crate::ComponentInspection,
) -> Result<(), ArtifactError> {
    let bytes = read_bounded(
        &reference.join("component-provenance.json"),
        REFERENCE_PROVENANCE_BYTES_MAX,
    )
    .map_err(|_| ArtifactError::ReferenceMismatch)?;
    let provenance: TypeScriptComponentProvenance =
        serde_json::from_slice(&bytes).map_err(|_| ArtifactError::ReferenceMismatch)?;
    if provenance.schema_version != 1
        || provenance.artifact != artifact
        || provenance.size_bytes != component.len() as u64
        || provenance.sha256 != component_sha256
        || provenance.source_wit_sha256 != source_wit_sha256
        || provenance.world_wit_sha256 != world_wit_sha256
        || provenance.node != TYPESCRIPT_NODE_VERSION
        || provenance.npm != TYPESCRIPT_NPM_VERSION
        || provenance.typescript != TYPESCRIPT_VERSION
        || provenance.jco != TYPESCRIPT_JCO_VERSION
        || provenance.componentize_js != TYPESCRIPT_COMPONENTIZE_JS_VERSION
        || provenance.wasi != "disabled-all"
        || provenance.imports != inspection.imports
        || provenance.exports != inspection.exports
        || provenance.reproducibility != "structural-not-byte"
    {
        return Err(ArtifactError::ReferenceMismatch);
    }
    Ok(())
}

fn require_package_match(
    expected_manifest: &RuntimeManifest,
    expected_component: &[u8],
    expected_public_key: &[u8; 32],
    actual_manifest: &RuntimeManifest,
    actual_component: &[u8],
    actual_public_key: &[u8; 32],
) -> Result<(), ArtifactError> {
    if expected_manifest != actual_manifest
        || expected_component != actual_component
        || expected_public_key != actual_public_key
    {
        return Err(ArtifactError::AuthorityMismatch);
    }
    Ok(())
}

fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>, ArtifactError> {
    let supplied = fs::symlink_metadata(path).map_err(|_| ArtifactError::InputUnavailable)?;
    if !regular_metadata_is_safe(&supplied) || supplied.len() > max as u64 {
        return Err(if supplied.len() > max as u64 {
            ArtifactError::InputTooLarge
        } else {
            ArtifactError::InputUnavailable
        });
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| ArtifactError::InputUnavailable)?;
    let opened = file
        .metadata()
        .map_err(|_| ArtifactError::InputUnavailable)?;
    if !regular_metadata_is_safe(&opened) || !same_file_metadata(&supplied, &opened) {
        return Err(ArtifactError::InputUnavailable);
    }

    let max_plus_one = max.checked_add(1).ok_or(ArtifactError::InputTooLarge)?;
    let mut bytes = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(0).min(max));
    file.take(max_plus_one as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ArtifactError::InputUnavailable)?;
    if bytes.len() > max {
        return Err(ArtifactError::InputTooLarge);
    }
    Ok(bytes)
}

fn require_output_absent(path: &Path) -> Result<(), ArtifactError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(ArtifactError::OutputExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ArtifactError::OutputUnavailable),
    }
}

fn require_directory(path: &Path) -> Result<(), ArtifactError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ArtifactError::InputUnavailable)?;
    if directory_metadata_is_safe(&metadata) {
        Ok(())
    } else {
        Err(ArtifactError::InputUnavailable)
    }
}

fn regular_metadata_is_safe(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && !metadata.file_type().is_symlink() && !metadata_is_reparse(metadata)
}

fn directory_metadata_is_safe(metadata: &fs::Metadata) -> bool {
    metadata.is_dir() && !metadata.file_type().is_symlink() && !metadata_is_reparse(metadata)
}

#[cfg(windows)]
fn metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn same_file_metadata(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file_metadata(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
}

#[cfg(unix)]
fn read_signing_key(path: &Path) -> Result<SigningKey, ArtifactError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let supplied_metadata =
        fs::symlink_metadata(path).map_err(|_| ArtifactError::KeyUnavailable)?;
    if supplied_metadata.file_type().is_symlink() || !supplied_metadata.is_file() {
        return Err(ArtifactError::KeyUnsafe);
    }
    validate_unix_key_metadata(&supplied_metadata)?;

    // Resolve parent components once, validate that fixed location, then open
    // that exact canonical path without following a final symlink.
    let canonical = fs::canonicalize(path).map_err(|_| ArtifactError::KeyUnavailable)?;
    validate_key_location(&canonical)?;
    let path_metadata =
        fs::symlink_metadata(&canonical).map_err(|_| ArtifactError::KeyUnavailable)?;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || path_metadata.dev() != supplied_metadata.dev()
        || path_metadata.ino() != supplied_metadata.ino()
    {
        return Err(ArtifactError::KeyUnsafe);
    }
    validate_unix_key_metadata(&path_metadata)?;

    let mut options = OpenOptions::new();
    options.read(true).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&canonical)
        .map_err(|_| ArtifactError::KeyUnavailable)?;
    let open_metadata = file.metadata().map_err(|_| ArtifactError::KeyUnavailable)?;
    if !open_metadata.is_file()
        || open_metadata.dev() != path_metadata.dev()
        || open_metadata.ino() != path_metadata.ino()
    {
        return Err(ArtifactError::KeyUnsafe);
    }
    validate_unix_key_metadata(&open_metadata)?;

    let mut seed = [0_u8; 32];
    if file.read_exact(&mut seed).is_err() {
        seed.fill(0);
        return Err(ArtifactError::KeyLength);
    }
    let mut trailing = [0_u8; 1];
    let trailing_count = match file.read(&mut trailing) {
        Ok(count) => count,
        Err(_) => {
            seed.fill(0);
            return Err(ArtifactError::KeyUnavailable);
        }
    };
    if trailing_count != 0 {
        seed.fill(0);
        return Err(ArtifactError::KeyLength);
    }
    let signing_key = SigningKey::from_bytes(&seed);
    seed.fill(0);
    Ok(signing_key)
}

#[cfg(unix)]
fn validate_unix_key_metadata(metadata: &fs::Metadata) -> Result<(), ArtifactError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    // Permit owner read/write combinations but no executable, special, group,
    // or other bits. A second hard link would bypass location policy.
    let mode = metadata.permissions().mode();
    if metadata.nlink() != 1 || mode & 0o7177 != 0 || mode & 0o400 == 0 {
        return Err(ArtifactError::KeyUnsafe);
    }
    Ok(())
}

#[cfg(windows)]
fn read_signing_key(_path: &Path) -> Result<SigningKey, ArtifactError> {
    // `std` can reject reparse metadata but cannot prove an owner-only DACL.
    // This first-stage tool therefore fails closed rather than claiming a
    // Windows key-custody guarantee it cannot establish without unsafe FFI.
    Err(ArtifactError::KeyPlatformUnsupported)
}

#[cfg(not(any(unix, windows)))]
fn read_signing_key(_path: &Path) -> Result<SigningKey, ArtifactError> {
    Err(ArtifactError::KeyPlatformUnsupported)
}

#[cfg(unix)]
fn validate_key_location(canonical: &Path) -> Result<(), ArtifactError> {
    if has_restricted_component(canonical)
        || is_checkout_contained(canonical)
        || checkout_roots()
            .iter()
            .any(|root| canonical.starts_with(root))
        || path_is_within_package_store(canonical, conventional_package_store_roots())
    {
        return Err(ArtifactError::KeyUnsafe);
    }
    Ok(())
}

#[cfg(unix)]
fn conventional_package_store_roots() -> Vec<PathBuf> {
    package_store_roots(
        std::env::var_os("HOME").map(PathBuf::from).as_deref(),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .as_deref(),
        std::env::var_os("CARGO_HOME").map(PathBuf::from).as_deref(),
    )
    .into_iter()
    .filter_map(|path| canonicalize_existing_ancestor(&path))
    .collect()
}

#[cfg(unix)]
fn path_is_within_package_store(path: &Path, roots: Vec<PathBuf>) -> bool {
    roots
        .iter()
        .filter_map(|root| canonicalize_existing_ancestor(root))
        .any(|root| path.starts_with(root))
}

#[cfg(unix)]
fn package_store_roots(
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    xdg_cache: Option<&Path>,
    xdg_data: Option<&Path>,
    cargo_home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home {
        for suffix in [
            ".local/share/pnpm/store",
            "Library/pnpm/store",
            "Library/Caches/npm",
            "Library/Caches/Yarn",
            "Library/Caches/bun",
            ".npm",
            ".cache/yarn",
            ".bun/install/cache",
            ".cargo/registry",
            ".cargo/git",
        ] {
            roots.push(home.join(suffix));
        }
    }
    if let Some(local_app_data) = local_app_data {
        for suffix in ["pnpm/store", "npm-cache", "Yarn/Cache", "bun/install/cache"] {
            roots.push(local_app_data.join(suffix));
        }
    }
    if let Some(xdg_cache) = xdg_cache {
        for suffix in ["pnpm/store", "npm", "yarn", "bun"] {
            roots.push(xdg_cache.join(suffix));
        }
    }
    if let Some(xdg_data) = xdg_data {
        roots.push(xdg_data.join("pnpm/store"));
    }
    if let Some(cargo_home) = cargo_home {
        roots.push(cargo_home.join("registry"));
        roots.push(cargo_home.join("git"));
    }
    roots
}

#[cfg(unix)]
fn canonicalize_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    if absolute
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return None;
    }

    let mut existing = absolute.as_path();
    let mut suffix = Vec::new();
    while fs::symlink_metadata(existing).is_err() {
        suffix.push(existing.file_name()?.to_owned());
        existing = existing.parent()?;
    }
    let mut canonical = fs::canonicalize(existing).ok()?;
    for component in suffix.iter().rev() {
        canonical.push(component);
    }
    Some(canonical)
}

#[cfg(unix)]
fn checkout_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .and_then(|path| fs::canonicalize(path).ok());
    if let Some(root) = manifest_root {
        roots.push(root);
    }
    if let Ok(mut current) = std::env::current_dir().and_then(fs::canonicalize) {
        loop {
            if current.join(".git").exists() {
                if !roots.contains(&current) {
                    roots.push(current);
                }
                break;
            }
            if !current.pop() {
                break;
            }
        }
    }
    roots
}

#[cfg(unix)]
fn is_checkout_contained(path: &Path) -> bool {
    path.ancestors()
        .any(|ancestor| ancestor.join(".git").exists())
}

#[cfg(unix)]
fn has_restricted_component(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(component) = component else {
            return false;
        };
        let name = component.to_string_lossy().to_ascii_lowercase();
        matches!(
            name.as_str(),
            "target"
                | "evidence"
                | "evidence-output"
                | "dogfood-output"
                | ".cargo"
                | ".npm"
                | ".pnpm-store"
                | "pnpm-store"
                | "npm-cache"
                | "node_modules"
                | ".yarn"
                | "yarn-cache"
                | ".bun"
                | ".cache"
                | "caches"
        )
    })
}

/// Publish through a same-directory hard link: the final name appears atomically
/// only after the complete temporary file is durable, and `hard_link` never
/// replaces an existing file or symlink. This works on filesystems that support
/// regular-file hard links; unsupported filesystems fail closed. Unix directory
/// entries are synced after the temporary name is removed. Other platforms keep
/// the same atomic no-replace guarantee, but `std` has no portable directory-sync
/// primitive.
fn write_new_output(path: &Path, bytes: &[u8]) -> Result<(), ArtifactError> {
    write_new_output_with(
        path,
        bytes,
        |file, bytes| file.write_all(bytes).and_then(|()| file.sync_all()),
        sync_parent_directory,
    )
}

fn write_new_public_key_output(path: &Path, bytes: &[u8; 32]) -> Result<(), ArtifactError> {
    write_new_output_with(
        path,
        bytes,
        |file, bytes| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o644))?;
            }
            file.write_all(bytes).and_then(|()| file.sync_all())
        },
        sync_parent_directory,
    )
}

fn write_new_output_with<P, S>(
    path: &Path,
    bytes: &[u8],
    persist_temp: P,
    sync_parent: S,
) -> Result<(), ArtifactError>
where
    P: FnOnce(&mut File, &[u8]) -> io::Result<()>,
    S: FnOnce(&Path) -> io::Result<()>,
{
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if path.file_name().is_none() {
        return Err(ArtifactError::OutputUnavailable);
    }

    let (mut file, mut temp) = create_output_temp(parent)?;
    persist_temp(&mut file, bytes).map_err(|_| ArtifactError::OutputUnavailable)?;

    fs::hard_link(&temp.path, path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists || fs::symlink_metadata(path).is_ok() {
            ArtifactError::OutputExists
        } else {
            ArtifactError::OutputUnavailable
        }
    })?;

    // The final name now refers only to complete, synced bytes. From this point
    // onward failures must never remove it.
    drop(file);
    let cleanup_result = temp.cleanup();
    let sync_result = sync_parent(parent);
    if cleanup_result.is_err() || sync_result.is_err() {
        return Err(ArtifactError::OutputDurability);
    }
    Ok(())
}

fn create_output_temp(parent: &Path) -> Result<(File, TempOutput), ArtifactError> {
    for _ in 0..128 {
        let path = parent.join(format!(
            ".junban-artifact-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o644).custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&path) {
            Ok(file) => {
                let temp = TempOutput { path, active: true };
                if !file
                    .metadata()
                    .map_err(|_| ArtifactError::OutputUnavailable)?
                    .is_file()
                {
                    return Err(ArtifactError::OutputUnavailable);
                }
                return Ok((file, temp));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(ArtifactError::OutputUnavailable),
        }
    }
    Err(ArtifactError::OutputUnavailable)
}

struct TempOutput {
    path: PathBuf,
    active: bool,
}

impl TempOutput {
    fn cleanup(&mut self) -> io::Result<()> {
        fs::remove_file(&self.path)?;
        self.active = false;
        Ok(())
    }
}

impl Drop for TempOutput {
    fn drop(&mut self) {
        if self.active {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};

    use crate::{
        Capability, Permission, PermissionScope, RuntimeProfile, SourcePublisher,
        UnscopedPermission, WitAuthority,
    };

    use super::*;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "junban-artifact-test-{}-{}",
                std::process::id(),
                TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            #[cfg(unix)]
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn source() -> SourceManifest {
        source_for("artifact-test")
    }

    fn source_for(plugin_id: &str) -> SourceManifest {
        SourceManifest {
            schema_version: 1,
            id: plugin_id.into(),
            name: format!("{plugin_id} test"),
            description: "Tool package behavior".into(),
            version: "1.0.0".into(),
            publisher: SourcePublisher {
                id: "artifact-publisher".into(),
                name: "Artifact Publisher".into(),
            },
            license: "MIT".into(),
            junban_compatibility: "^0.1".into(),
            wit: WitAuthority {
                package: "junban:plugin".into(),
                world: "plugin".into(),
                version: "0.1.0".into(),
            },
            runtime_profile: RuntimeProfile::Rust,
            permissions: [
                Capability::Logging,
                Capability::Settings,
                Capability::Storage,
                Capability::TasksRead,
            ]
            .into_iter()
            .map(|capability| Permission {
                capability,
                scope: PermissionScope::Unscoped(UnscopedPermission {}),
            })
            .collect(),
            dependencies: Vec::new(),
            commands: Vec::new(),
            subscriptions: Vec::new(),
            surfaces: Vec::new(),
            settings: Vec::new(),
            services: Vec::new(),
        }
    }

    #[cfg(unix)]
    fn write_key(path: &Path, seed: &[u8]) {
        fs::write(path, seed).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    fn assert_no_output_temps(root: &Path) {
        assert!(fs::read_dir(root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".junban-artifact-")
        }));
    }

    struct RegistryFixture {
        component: PathBuf,
        publisher_public_key: PathBuf,
        packages: PathBuf,
        metadata: PathBuf,
        root_public_key: PathBuf,
        index: PathBuf,
        include_table: PathBuf,
        references: PathBuf,
        package: PathBuf,
    }

    fn registry_fixture(root: &Path) -> RegistryFixture {
        registry_fixture_named(root, "artifact-test", "artifact-test")
    }

    fn registry_fixture_named(
        root: &Path,
        plugin_id: &str,
        reference_directory: &str,
    ) -> RegistryFixture {
        let source_path = root.join("source.json");
        let component_path = root.join("component.wasm");
        let component = include_bytes!("../consumers/rust/rust-consumer.wasm");
        let source = source_for(plugin_id);
        fs::write(&source_path, serde_json::to_vec_pretty(&source).unwrap()).unwrap();
        fs::write(&component_path, component).unwrap();

        let publisher_key = SigningKey::from_bytes(&[41; 32]);
        let publisher_public_key_bytes = publisher_key.verifying_key().to_bytes();
        let publisher_public_key = root.join("publisher-public-key.bin");
        fs::write(&publisher_public_key, publisher_public_key_bytes).unwrap();
        let runtime = source
            .derive_runtime_manifest(component, &publisher_public_key_bytes)
            .unwrap();
        let inspection = inspect_component(component, &runtime).unwrap();
        let package_bytes = pack_package(&runtime, component, &publisher_key).unwrap();

        let packages = root.join("sha256");
        fs::create_dir(&packages).unwrap();
        let digest = hex(&sha256(&package_bytes));
        let package = packages.join(format!("{digest}.jbp"));
        fs::write(&package, package_bytes).unwrap();

        let metadata_authority = RegistrySourceMetadata {
            schema_version: 1,
            generated_at: "2026-08-12T00:00:00Z".into(),
            entries: vec![RegistrySourceEntry {
                plugin_id: plugin_id.into(),
                version: "1.0.0".into(),
                search_tags: vec!["tasks".into(), "testing".into()],
            }],
        };
        let metadata = root.join("registry-source.json");
        fs::write(
            &metadata,
            serde_json::to_vec_pretty(&metadata_authority).unwrap(),
        )
        .unwrap();

        let root_key = SigningKey::from_bytes(&[43; 32]);
        let root_public_key_bytes = root_key.verifying_key().to_bytes();
        let package_records = scan_package_directory(&packages).unwrap();
        let registry = build_registry_index(
            &metadata_authority,
            &package_records,
            &root_public_key_bytes,
        )
        .unwrap();
        let root_public_key = root.join("root-public-key.bin");
        fs::write(&root_public_key, root_public_key_bytes).unwrap();
        let index = root.join("index.jri");
        fs::write(&index, pack_registry(&registry, &root_key).unwrap()).unwrap();
        let include_table = root.join("bundled_registry_include.rs");
        write_registry_include_table(
            &root_public_key,
            &publisher_public_key,
            &index,
            &packages,
            &include_table,
            false,
        )
        .unwrap();

        let references = root.join("references");
        let reference = references.join(reference_directory);
        fs::create_dir_all(reference.join("artifacts")).unwrap();
        fs::create_dir_all(reference.join("wit/deps/junban-plugin")).unwrap();
        fs::copy(&source_path, reference.join("plugin-source.json")).unwrap();
        fs::copy(
            &component_path,
            reference.join(format!("artifacts/{plugin_id}.wasm")),
        )
        .unwrap();
        fs::write(
            reference.join("wit/deps/junban-plugin/plugin.wit"),
            WIT_SOURCE,
        )
        .unwrap();
        let world_wit =
            b"package test:reference@0.1.0;\nworld test { include junban:plugin/plugin@0.1.0; }\n";
        fs::write(reference.join("wit/world.wit"), world_wit).unwrap();
        fs::write(
            reference.join("reference-authority.json"),
            serde_json::to_vec_pretty(&RustReferenceAuthority {
                schema_version: 1,
                artifact: format!("artifacts/{plugin_id}.wasm"),
                size_bytes: component.len() as u64,
                sha256: hex(&sha256(component)),
                source_wit_sha256: hex(&sha256(WIT_SOURCE.as_bytes())),
                world_wit_sha256: hex(&sha256(world_wit)),
                imports: inspection.imports,
                exports: inspection.exports,
                reproducibility: "byte-for-byte".into(),
            })
            .unwrap(),
        )
        .unwrap();

        RegistryFixture {
            component: component_path,
            publisher_public_key,
            packages,
            metadata,
            root_public_key,
            index,
            include_table,
            references,
            package,
        }
    }

    fn assert_public_registry_valid(fixture: &RegistryFixture) {
        verify_registry_references(
            &fixture.references,
            &fixture.metadata,
            &fixture.root_public_key,
            &fixture.publisher_public_key,
            &fixture.index,
            &fixture.packages,
            &fixture.include_table,
        )
        .unwrap();
    }

    fn assert_public_registry_invalid(fixture: &RegistryFixture) {
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
    }

    fn write_reference_source(root: &Path, directory: &str, plugin_id: &str) -> PathBuf {
        let reference = root.join(directory);
        fs::create_dir(&reference).unwrap();
        fs::write(
            reference.join("plugin-source.json"),
            serde_json::to_vec(&source_for(plugin_id)).unwrap(),
        )
        .unwrap();
        reference
    }

    #[test]
    fn reference_scan_keys_authoring_directories_by_strict_source_id() {
        let root = TestDir::new();
        let references = root.0.join("references");
        fs::create_dir(&references).unwrap();
        let expected = [
            ("automation-rust", "automation"),
            ("import-typescript", "import-typescript"),
            ("pomodoro-rust", "pomodoro"),
        ];
        for (directory, plugin_id) in expected {
            write_reference_source(&references, directory, plugin_id);
        }

        let scanned = scan_reference_directories(&references).unwrap();
        assert_eq!(
            scanned.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["automation", "import-typescript", "pomodoro"]
        );
        for (directory, plugin_id) in expected {
            let reference = scanned.get(plugin_id).unwrap();
            assert_eq!(reference.path.file_name().unwrap(), directory);
            assert_eq!(reference.source.id, plugin_id);
        }
    }

    #[test]
    fn reference_scan_rejects_duplicate_malformed_and_missing_source_ids() {
        let duplicate_root = TestDir::new();
        let duplicate_references = duplicate_root.0.join("references");
        fs::create_dir(&duplicate_references).unwrap();
        write_reference_source(&duplicate_references, "automation-rust", "automation");
        write_reference_source(&duplicate_references, "automation-copy", "automation");
        assert!(matches!(
            scan_reference_directories(&duplicate_references),
            Err(ArtifactError::ReferenceMismatch)
        ));

        let malformed_root = TestDir::new();
        let malformed_references = malformed_root.0.join("references");
        fs::create_dir(&malformed_references).unwrap();
        let malformed = malformed_references.join("pomodoro-rust");
        fs::create_dir(&malformed).unwrap();
        fs::write(malformed.join("plugin-source.json"), b"{not-json").unwrap();
        assert!(matches!(
            scan_reference_directories(&malformed_references),
            Err(ArtifactError::ReferenceMismatch)
        ));

        let missing_root = TestDir::new();
        let missing_references = missing_root.0.join("references");
        fs::create_dir_all(missing_references.join("import-typescript")).unwrap();
        assert!(matches!(
            scan_reference_directories(&missing_references),
            Err(ArtifactError::ReferenceMismatch)
        ));
    }

    #[test]
    fn signed_registry_verifier_resolves_authoring_directories_by_source_id() {
        for (directory, plugin_id) in [
            ("automation-rust", "automation"),
            ("import-typescript", "import-typescript"),
            ("pomodoro-rust", "pomodoro"),
        ] {
            let root = TestDir::new();
            let fixture = registry_fixture_named(&root.0, plugin_id, directory);
            assert_public_registry_valid(&fixture);
        }
    }

    fn add_mixed_publisher_package(fixture: &RegistryFixture) {
        let component = fs::read(&fixture.component).unwrap();
        let mut mixed_source = source();
        mixed_source.id = "mixed-publisher".into();
        mixed_source.name = "Mixed publisher".into();
        let mixed_key = SigningKey::from_bytes(&[77; 32]);
        let mixed_public_key = mixed_key.verifying_key().to_bytes();
        let runtime = mixed_source
            .derive_runtime_manifest(&component, &mixed_public_key)
            .unwrap();
        let package_bytes = pack_package(&runtime, &component, &mixed_key).unwrap();
        let package_digest = hex(&sha256(&package_bytes));
        fs::write(
            fixture.packages.join(format!("{package_digest}.jbp")),
            package_bytes,
        )
        .unwrap();

        let metadata = RegistrySourceMetadata {
            schema_version: 1,
            generated_at: "2026-08-12T00:00:00Z".into(),
            entries: vec![
                RegistrySourceEntry {
                    plugin_id: "artifact-test".into(),
                    version: "1.0.0".into(),
                    search_tags: vec!["tasks".into(), "testing".into()],
                },
                RegistrySourceEntry {
                    plugin_id: "mixed-publisher".into(),
                    version: "1.0.0".into(),
                    search_tags: Vec::new(),
                },
            ],
        };
        fs::write(
            &fixture.metadata,
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        let root_key = SigningKey::from_bytes(&[43; 32]);
        let packages = scan_package_directory(&fixture.packages).unwrap();
        let index =
            build_registry_index(&metadata, &packages, &root_key.verifying_key().to_bytes())
                .unwrap();
        fs::write(&fixture.index, pack_registry(&index, &root_key).unwrap()).unwrap();
    }

    #[test]
    fn output_publication_writes_exact_bytes_and_cleans_its_temp() {
        let root = TestDir::new();
        let output = root.0.join("package.jbp");
        let bytes = b"complete signed package bytes";

        write_new_output(&output, bytes).unwrap();

        assert_eq!(fs::read(output).unwrap(), bytes);
        assert_no_output_temps(&root.0);
    }

    #[cfg(unix)]
    #[test]
    fn signing_public_key_publication_derives_exact_valid_public_bytes() {
        let root = TestDir::new();
        let key = root.0.join("publisher.seed");
        let output = root.0.join("publisher-public-key.bin");
        let seed = [53_u8; 32];
        let expected = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        write_key(&key, &seed);

        publish_signing_public_key(&key, &output).unwrap();

        assert_eq!(fs::read(&output).unwrap(), expected);
        assert_eq!(read_public_key(&output).unwrap(), expected);
        assert_eq!(
            fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert_no_output_temps(&root.0);
    }

    #[cfg(unix)]
    #[test]
    fn signing_public_key_publication_never_overwrites_output() {
        let root = TestDir::new();
        let key = root.0.join("publisher.seed");
        let output = root.0.join("publisher-public-key.bin");
        let incumbent = [0xa5_u8; 32];
        write_key(&key, &[59; 32]);
        fs::write(&output, incumbent).unwrap();

        assert_eq!(
            publish_signing_public_key(&key, &output),
            Err(ArtifactError::OutputExists)
        );
        assert_eq!(fs::read(output).unwrap(), incumbent);
        assert_no_output_temps(&root.0);
    }

    #[cfg(unix)]
    #[test]
    fn signing_public_key_publication_inherits_strict_key_policy() {
        let root = TestDir::new();
        let key = root.0.join("unsafe-publisher.seed");
        let output = root.0.join("publisher-public-key.bin");
        write_key(&key, &[61; 32]);
        fs::set_permissions(&key, fs::Permissions::from_mode(0o640)).unwrap();

        assert_eq!(
            publish_signing_public_key(&key, &output),
            Err(ArtifactError::KeyUnsafe)
        );
        assert!(!output.exists());
        assert_no_output_temps(&root.0);
    }

    #[test]
    fn output_publication_write_and_temp_sync_failures_expose_no_final_bytes() {
        let root = TestDir::new();
        let write_output = root.0.join("write-failure.jbp");
        let sync_output = root.0.join("sync-failure.jbp");
        let bytes = b"bytes that must never be partial";

        let write_result = write_new_output_with(
            &write_output,
            bytes,
            |file, bytes| {
                file.write_all(&bytes[..5])?;
                Err(io::Error::other("injected write failure"))
            },
            |_| panic!("parent sync must not run"),
        );
        assert_eq!(write_result, Err(ArtifactError::OutputUnavailable));
        assert!(!write_output.exists());
        assert_no_output_temps(&root.0);

        let sync_result = write_new_output_with(
            &sync_output,
            bytes,
            |file, bytes| {
                file.write_all(bytes)?;
                Err(io::Error::other("injected temp sync failure"))
            },
            |_| panic!("parent sync must not run"),
        );
        assert_eq!(sync_result, Err(ArtifactError::OutputUnavailable));
        assert!(!sync_output.exists());
        assert_no_output_temps(&root.0);
    }

    #[test]
    fn output_publication_never_overwrites_preexisting_or_racing_destinations() {
        let root = TestDir::new();
        let existing = root.0.join("existing.jbp");
        let racing = root.0.join("racing.jbp");
        let incumbent = b"incumbent complete artifact";
        fs::write(&existing, incumbent).unwrap();

        assert_eq!(
            write_new_output(&existing, b"replacement"),
            Err(ArtifactError::OutputExists)
        );
        assert_eq!(fs::read(&existing).unwrap(), incumbent);
        assert_no_output_temps(&root.0);

        let race_result = write_new_output_with(
            &racing,
            b"challenger",
            |file, bytes| {
                file.write_all(bytes)?;
                file.sync_all()?;
                fs::write(&racing, incumbent)
            },
            |_| panic!("parent sync must not run"),
        );
        assert_eq!(race_result, Err(ArtifactError::OutputExists));
        assert_eq!(fs::read(racing).unwrap(), incumbent);
        assert_no_output_temps(&root.0);
    }

    #[cfg(unix)]
    #[test]
    fn output_publication_does_not_follow_a_destination_symlink() {
        let root = TestDir::new();
        let target = root.0.join("target.jbp");
        let output = root.0.join("output.jbp");
        fs::write(&target, b"symlink target").unwrap();
        symlink(&target, &output).unwrap();

        assert_eq!(
            write_new_output(&output, b"replacement"),
            Err(ArtifactError::OutputExists)
        );
        assert_eq!(fs::read(target).unwrap(), b"symlink target");
        assert_no_output_temps(&root.0);
    }

    #[test]
    fn output_directory_sync_failure_keeps_the_complete_published_artifact() {
        let root = TestDir::new();
        let output = root.0.join("package.jbp");
        let bytes = b"complete before publication";

        let result = write_new_output_with(
            &output,
            bytes,
            |file, bytes| file.write_all(bytes).and_then(|()| file.sync_all()),
            |_| Err(io::Error::other("injected directory sync failure")),
        );

        assert_eq!(result, Err(ArtifactError::OutputDurability));
        assert_eq!(fs::read(output).unwrap(), bytes);
        assert_no_output_temps(&root.0);
    }

    #[test]
    fn public_package_verifier_binds_source_component_and_embedded_key() {
        let root = TestDir::new();
        let source_path = root.0.join("source.json");
        let component_path = root.0.join("component.wasm");
        let package_path = root.0.join("package.jbp");
        let source = source();
        let component = include_bytes!("../consumers/rust/rust-consumer.wasm");
        let signing_key = SigningKey::from_bytes(&[23; 32]);
        let runtime = source
            .derive_runtime_manifest(component, &signing_key.verifying_key().to_bytes())
            .unwrap();
        fs::write(&source_path, serde_json::to_vec_pretty(&source).unwrap()).unwrap();
        fs::write(&component_path, component).unwrap();
        fs::write(
            &package_path,
            pack_package(&runtime, component, &signing_key).unwrap(),
        )
        .unwrap();

        verify_package_artifact(&source_path, &component_path, &package_path).unwrap();
        let mut drifted = component.to_vec();
        *drifted.last_mut().unwrap() ^= 1;
        fs::write(&component_path, drifted).unwrap();
        assert_eq!(
            verify_package_artifact(&source_path, &component_path, &package_path),
            Err(ArtifactError::AuthorityMismatch)
        );
    }

    #[cfg(unix)]
    #[test]
    fn package_signing_never_overwrites_and_publicly_verifies_output() {
        let root = TestDir::new();
        let source_path = root.0.join("source.json");
        let component_path = root.0.join("component.wasm");
        let key_path = root.0.join("publisher.seed");
        let output_path = root.0.join("package.jbp");
        fs::write(&source_path, serde_json::to_vec_pretty(&source()).unwrap()).unwrap();
        fs::write(
            &component_path,
            include_bytes!("../consumers/rust/rust-consumer.wasm"),
        )
        .unwrap();
        write_key(&key_path, &[23; 32]);

        assert!(check_source_manifest(&source_path).is_ok());
        sign_package_artifact(&source_path, &component_path, &key_path, &output_path).unwrap();
        verify_package_artifact(&source_path, &component_path, &output_path).unwrap();
        assert_eq!(
            sign_package_artifact(&source_path, &component_path, &key_path, &output_path),
            Err(ArtifactError::OutputExists)
        );

        let mut drifted = fs::read(&component_path).unwrap();
        *drifted.last_mut().unwrap() ^= 1;
        fs::write(&component_path, drifted).unwrap();
        assert_eq!(
            verify_package_artifact(&source_path, &component_path, &output_path),
            Err(ArtifactError::AuthorityMismatch)
        );
    }

    #[test]
    fn registry_metadata_rejects_unknown_duplicate_order_tags_and_timestamps() {
        let valid = RegistrySourceMetadata {
            schema_version: 1,
            generated_at: "2026-08-12T00:00:00Z".into(),
            entries: vec![
                RegistrySourceEntry {
                    plugin_id: "a".into(),
                    version: "1.0.0".into(),
                    search_tags: vec!["one".into(), "two".into()],
                },
                RegistrySourceEntry {
                    plugin_id: "b".into(),
                    version: "1.0.0".into(),
                    search_tags: Vec::new(),
                },
            ],
        };
        let json = serde_json::to_string(&valid).unwrap();
        assert!(RegistrySourceMetadata::parse(json.as_bytes()).is_ok());
        for invalid in [
            json.replacen('{', "{\"unknown\":true,", 1),
            json.replacen(
                "\"plugin_id\":\"a\"",
                "\"plugin_id\":\"a\",\"unknown\":true",
                1,
            ),
            json.replacen(
                "\"schema_version\":1",
                "\"schema_version\":1,\"schema_version\":1",
                1,
            ),
            json.replace("2026-08-12T00:00:00Z", "2026-08-12T00:00:00+00:00"),
        ] {
            assert!(RegistrySourceMetadata::parse(invalid.as_bytes()).is_err());
        }

        let mut duplicate = valid.clone();
        duplicate.entries[1] = duplicate.entries[0].clone();
        assert!(duplicate.validate().is_err());
        let mut unordered = valid.clone();
        unordered.entries.reverse();
        assert!(unordered.validate().is_err());
        let mut bad_tags = valid;
        bad_tags.entries[0].search_tags = vec!["two".into(), "one".into()];
        assert!(bad_tags.validate().is_err());
    }

    #[test]
    fn public_registry_requires_exact_strict_source_metadata() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let original = fs::read(&fixture.metadata).unwrap();
        let authority = RegistrySourceMetadata::parse(&original).unwrap();
        assert_public_registry_valid(&fixture);

        let mut drifted = authority.clone();
        drifted.generated_at = "2026-08-13T00:00:00Z".into();
        fs::write(&fixture.metadata, serde_json::to_vec(&drifted).unwrap()).unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );

        let mut drifted = authority.clone();
        drifted.entries[0].search_tags = vec!["changed".into()];
        fs::write(&fixture.metadata, serde_json::to_vec(&drifted).unwrap()).unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );

        let mut drifted = authority.clone();
        drifted.entries[0].plugin_id = "changed-plugin".into();
        fs::write(&fixture.metadata, serde_json::to_vec(&drifted).unwrap()).unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );

        let mut reordered = authority.clone();
        reordered.entries.insert(
            0,
            RegistrySourceEntry {
                plugin_id: "another-plugin".into(),
                version: "1.0.0".into(),
                search_tags: Vec::new(),
            },
        );
        fs::write(&fixture.metadata, serde_json::to_vec(&reordered).unwrap()).unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );
        reordered.entries.reverse();
        fs::write(&fixture.metadata, serde_json::to_vec(&reordered).unwrap()).unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::MetadataInvalid)
        );

        let mut unknown: serde_json::Value = serde_json::from_slice(&original).unwrap();
        unknown["unknown"] = serde_json::Value::Bool(true);
        fs::write(&fixture.metadata, serde_json::to_vec(&unknown).unwrap()).unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::MetadataInvalid)
        );

        fs::write(&fixture.metadata, b"{").unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::MetadataInvalid)
        );

        fs::write(&fixture.metadata, original).unwrap();
        assert_public_registry_valid(&fixture);
    }

    #[test]
    fn public_registry_rejects_mixed_or_wrong_exact_publisher_authority() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let wrong_publisher = root.0.join("wrong-publisher.bin");
        fs::write(
            &wrong_publisher,
            SigningKey::from_bytes(&[78; 32]).verifying_key().to_bytes(),
        )
        .unwrap();
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &wrong_publisher,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );

        add_mixed_publisher_package(&fixture);
        assert_eq!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );
    }

    #[cfg(unix)]
    #[test]
    fn index_signing_checks_exact_publisher_before_reading_root_private_key() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        add_mixed_publisher_package(&fixture);
        let root_output = root.0.join("mixed-root.bin");
        let index_output = root.0.join("mixed-index.jri");
        assert_eq!(
            sign_registry_index(
                &fixture.packages,
                &fixture.metadata,
                &fixture.publisher_public_key,
                &root.0.join("deliberately-missing-root.seed"),
                &root_output,
                &index_output,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );
        assert!(!root_output.exists());
        assert!(!index_output.exists());
    }

    #[cfg(unix)]
    #[test]
    fn registry_index_signing_is_deterministic_and_wrong_root_fails() {
        let first_root = TestDir::new();
        let fixture = registry_fixture(&first_root.0);
        let root_key = first_root.0.join("root.seed");
        write_key(&root_key, &[43; 32]);
        let second_root_key_output = first_root.0.join("root-public-key-2.bin");
        let second_index = first_root.0.join("index-2.jri");
        sign_registry_index(
            &fixture.packages,
            &fixture.metadata,
            &fixture.publisher_public_key,
            &root_key,
            &second_root_key_output,
            &second_index,
        )
        .unwrap();
        assert_eq!(
            fs::read(&fixture.index).unwrap(),
            fs::read(second_index).unwrap()
        );
        assert_eq!(
            fs::read(&fixture.root_public_key).unwrap(),
            fs::read(second_root_key_output).unwrap()
        );

        let wrong_key = SigningKey::from_bytes(&[99; 32]).verifying_key().to_bytes();
        assert!(parse_and_verify_registry(&fs::read(&fixture.index).unwrap(), &wrong_key).is_err());

        let metadata = RegistrySourceMetadata {
            schema_version: 1,
            generated_at: "2026-08-12T00:00:00Z".into(),
            entries: Vec::new(),
        };
        fs::write(&fixture.metadata, serde_json::to_vec(&metadata).unwrap()).unwrap();
        let unmatched_root = first_root.0.join("unmatched-root.bin");
        let unmatched_index = first_root.0.join("unmatched-index.jri");
        assert_eq!(
            sign_registry_index(
                &fixture.packages,
                &fixture.metadata,
                &fixture.publisher_public_key,
                &root_key,
                &unmatched_root,
                &unmatched_index,
            ),
            Err(ArtifactError::AuthorityMismatch)
        );
        assert!(!unmatched_root.exists());
        assert!(!unmatched_index.exists());
    }

    #[cfg(unix)]
    #[test]
    fn index_signing_preflight_never_publishes_over_existing_output() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let root_key = root.0.join("root.seed");
        write_key(&root_key, &[43; 32]);
        let existing_index = root.0.join("existing-index.jri");
        let absent_root = root.0.join("absent-root.bin");
        fs::write(&existing_index, b"incumbent").unwrap();
        assert_eq!(
            sign_registry_index(
                &fixture.packages,
                &fixture.metadata,
                &fixture.publisher_public_key,
                &root_key,
                &absent_root,
                &existing_index,
            ),
            Err(ArtifactError::OutputExists)
        );
        assert!(!absent_root.exists());
        assert_eq!(fs::read(existing_index).unwrap(), b"incumbent");

        let existing_root = root.0.join("existing-root.bin");
        let absent_index = root.0.join("absent-index.jri");
        fs::write(&existing_root, b"incumbent").unwrap();
        assert_eq!(
            sign_registry_index(
                &fixture.packages,
                &fixture.metadata,
                &fixture.publisher_public_key,
                &root_key,
                &existing_root,
                &absent_index,
            ),
            Err(ArtifactError::OutputExists)
        );
        assert!(!absent_index.exists());
        assert_eq!(fs::read(existing_root).unwrap(), b"incumbent");
    }

    #[test]
    fn package_directory_rejects_missing_extra_misnamed_and_symlink_entries() {
        let extra_root = TestDir::new();
        let extra = registry_fixture(&extra_root.0);
        fs::write(extra.packages.join("extra.txt"), b"not a package").unwrap();
        assert!(scan_package_directory(&extra.packages).is_err());

        let missing_root = TestDir::new();
        let missing = registry_fixture(&missing_root.0);
        fs::remove_file(&missing.package).unwrap();
        assert!(
            verify_registry_files(
                &missing.root_public_key,
                &missing.publisher_public_key,
                &missing.index,
                &missing.packages,
            )
            .is_err()
        );

        let misnamed_root = TestDir::new();
        let misnamed = registry_fixture(&misnamed_root.0);
        let wrong_name = misnamed.packages.join(format!("{}.jbp", "0".repeat(64)));
        fs::rename(&misnamed.package, wrong_name).unwrap();
        assert!(scan_package_directory(&misnamed.packages).is_err());

        #[cfg(unix)]
        {
            let symlink_root = TestDir::new();
            let linked = registry_fixture(&symlink_root.0);
            let link = linked.packages.join(format!("{}.jbp", "1".repeat(64)));
            symlink(&linked.package, link).unwrap();
            assert!(scan_package_directory(&linked.packages).is_err());
        }
    }

    #[test]
    fn include_table_generation_and_check_are_exact_and_detect_drift() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let generated = fs::read_to_string(&fixture.include_table).unwrap();
        assert!(generated.starts_with("// @generated by junban-plugin-artifact"));
        assert!(generated.contains(&fixture.package.file_name().unwrap().to_string_lossy()[..64]));
        assert!(generated.contains("include_bytes!(\"../../../plugins/registry/sha256/"));
        write_registry_include_table(
            &fixture.root_public_key,
            &fixture.publisher_public_key,
            &fixture.index,
            &fixture.packages,
            &fixture.include_table,
            true,
        )
        .unwrap();
        assert_eq!(
            write_registry_include_table(
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
                false,
            ),
            Err(ArtifactError::OutputExists)
        );
        fs::write(&fixture.include_table, format!("{generated}// drift\n")).unwrap();
        assert_eq!(
            write_registry_include_table(
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
                true,
            ),
            Err(ArtifactError::IncludeDrift)
        );
    }

    #[test]
    fn public_registry_verifier_succeeds_without_private_keys_and_rejects_all_drift() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        assert_public_registry_valid(&fixture);

        let reference = fixture.references.join("artifact-test");
        let source_path = reference.join("plugin-source.json");
        let original_source = fs::read(&source_path).unwrap();
        let mut drifted_source = source();
        drifted_source.description = "source drift".into();
        fs::write(&source_path, serde_json::to_vec(&drifted_source).unwrap()).unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&source_path, original_source).unwrap();

        let component_path = reference.join("artifacts/artifact-test.wasm");
        let mut component = fs::read(&component_path).unwrap();
        *component.last_mut().unwrap() ^= 1;
        fs::write(&component_path, &component).unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::copy(&fixture.component, &component_path).unwrap();

        let wit_path = reference.join("wit/deps/junban-plugin/plugin.wit");
        fs::write(&wit_path, "wit drift").unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&wit_path, WIT_SOURCE).unwrap();

        let original_package = fs::read(&fixture.package).unwrap();
        let mut package = original_package.clone();
        *package.last_mut().unwrap() ^= 1;
        fs::write(&fixture.package, package).unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&fixture.package, original_package).unwrap();

        let original_index = fs::read(&fixture.index).unwrap();
        let mut index = original_index.clone();
        *index.last_mut().unwrap() ^= 1;
        fs::write(&fixture.index, index).unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&fixture.index, original_index).unwrap();

        let original_root = fs::read(&fixture.root_public_key).unwrap();
        fs::write(
            &fixture.root_public_key,
            SigningKey::from_bytes(&[101; 32])
                .verifying_key()
                .to_bytes(),
        )
        .unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&fixture.root_public_key, original_root).unwrap();

        let include = fs::read(&fixture.include_table).unwrap();
        fs::write(&fixture.include_table, b"include drift").unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&fixture.include_table, include).unwrap();
        assert_public_registry_valid(&fixture);
    }

    #[test]
    fn public_registry_rejects_reference_tree_world_and_rust_authority_drift() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let reference = fixture.references.join("artifact-test");
        let artifact = reference.join("artifacts/artifact-test.wasm");
        let component = fs::read(&artifact).unwrap();
        let world = reference.join("wit/world.wit");
        let world_bytes = fs::read(&world).unwrap();
        let authority = reference.join("reference-authority.json");
        let authority_bytes = fs::read(&authority).unwrap();

        fs::remove_file(&artifact).unwrap();
        assert!(
            verify_registry_references(
                &fixture.references,
                &fixture.metadata,
                &fixture.root_public_key,
                &fixture.publisher_public_key,
                &fixture.index,
                &fixture.packages,
                &fixture.include_table,
            )
            .is_err()
        );
        fs::write(&artifact, &component).unwrap();

        let misnamed = reference.join("artifacts/wrong.wasm");
        fs::rename(&artifact, &misnamed).unwrap();
        assert_public_registry_invalid(&fixture);
        fs::rename(&misnamed, &artifact).unwrap();

        let extra_artifact = reference.join("artifacts/extra.txt");
        fs::write(&extra_artifact, b"extra").unwrap();
        assert_public_registry_invalid(&fixture);
        fs::remove_file(extra_artifact).unwrap();
        let extra_artifact_dir = reference.join("artifacts/extra");
        fs::create_dir(&extra_artifact_dir).unwrap();
        assert_public_registry_invalid(&fixture);
        fs::remove_dir(extra_artifact_dir).unwrap();

        let extra_wit = reference.join("wit/extra.wit");
        fs::write(&extra_wit, b"extra").unwrap();
        assert_public_registry_invalid(&fixture);
        fs::remove_file(extra_wit).unwrap();

        fs::write(&world, b"world drift").unwrap();
        assert_public_registry_invalid(&fixture);
        fs::write(&world, world_bytes).unwrap();

        fs::remove_file(&authority).unwrap();
        assert_public_registry_invalid(&fixture);
        fs::write(&authority, &authority_bytes).unwrap();

        fs::write(
            &authority,
            String::from_utf8(authority_bytes.clone())
                .unwrap()
                .replacen('{', "{\"unknown\":true,", 1),
        )
        .unwrap();
        assert_public_registry_invalid(&fixture);
        fs::write(&authority, &authority_bytes).unwrap();

        let mut parsed: RustReferenceAuthority = serde_json::from_slice(&authority_bytes).unwrap();
        parsed.world_wit_sha256 = "0".repeat(64);
        fs::write(&authority, serde_json::to_vec(&parsed).unwrap()).unwrap();
        assert_public_registry_invalid(&fixture);
        fs::write(&authority, authority_bytes).unwrap();
        assert_public_registry_valid(&fixture);
    }

    #[cfg(unix)]
    #[test]
    fn public_registry_rejects_reference_authority_symlinks() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let reference = fixture.references.join("artifact-test");
        let artifact = reference.join("artifacts/artifact-test.wasm");
        let target = reference.join("artifact-target.wasm");
        fs::rename(&artifact, &target).unwrap();
        symlink(&target, &artifact).unwrap();
        assert_public_registry_invalid(&fixture);
    }

    #[test]
    fn typescript_provenance_is_exact_typed_and_recomputed() {
        let root = TestDir::new();
        let component = b"typescript component fixture";
        let world = b"typescript world fixture";
        let inspection = crate::ComponentInspection {
            imports: vec!["junban:plugin/types@0.1.0".into()],
            exports: vec![crate::REQUIRED_GUEST_EXPORT.into()],
            guest_abi_sha256: "1".repeat(64),
            import_export_fingerprint: "2".repeat(64),
            authority_metadata_bytes: 0,
        };
        let provenance = TypeScriptComponentProvenance {
            schema_version: 1,
            artifact: "artifacts/typescript-fixture.wasm".into(),
            size_bytes: u64::try_from(component.len()).unwrap(),
            sha256: hex(&sha256(component)),
            source_wit_sha256: hex(&sha256(WIT_SOURCE.as_bytes())),
            world_wit_sha256: hex(&sha256(world)),
            node: TYPESCRIPT_NODE_VERSION.into(),
            npm: TYPESCRIPT_NPM_VERSION.into(),
            typescript: TYPESCRIPT_VERSION.into(),
            jco: TYPESCRIPT_JCO_VERSION.into(),
            componentize_js: TYPESCRIPT_COMPONENTIZE_JS_VERSION.into(),
            wasi: "disabled-all".into(),
            imports: inspection.imports.clone(),
            exports: inspection.exports.clone(),
            reproducibility: "structural-not-byte".into(),
        };
        let path = root.0.join("component-provenance.json");
        let bytes = serde_json::to_vec(&provenance).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(
            verify_typescript_component_provenance(
                &root.0,
                "artifacts/typescript-fixture.wasm",
                component,
                &provenance.sha256,
                &provenance.source_wit_sha256,
                &provenance.world_wit_sha256,
                &inspection,
            )
            .is_ok()
        );

        fs::write(
            &path,
            String::from_utf8(bytes.clone())
                .unwrap()
                .replacen('{', "{\"unknown\":true,", 1),
        )
        .unwrap();
        assert!(
            verify_typescript_component_provenance(
                &root.0,
                "artifacts/typescript-fixture.wasm",
                component,
                &provenance.sha256,
                &provenance.source_wit_sha256,
                &provenance.world_wit_sha256,
                &inspection,
            )
            .is_err()
        );

        let mut drifted = provenance.clone();
        drifted.imports.clear();
        fs::write(&path, serde_json::to_vec(&drifted).unwrap()).unwrap();
        assert!(
            verify_typescript_component_provenance(
                &root.0,
                "artifacts/typescript-fixture.wasm",
                component,
                &provenance.sha256,
                &provenance.source_wit_sha256,
                &provenance.world_wit_sha256,
                &inspection,
            )
            .is_err()
        );
    }

    #[test]
    fn public_registry_rejects_extra_and_missing_references_and_packages() {
        let references_root = TestDir::new();
        let references = registry_fixture(&references_root.0);
        fs::create_dir(references.references.join("extra")).unwrap();
        assert!(
            verify_registry_references(
                &references.references,
                &references.metadata,
                &references.root_public_key,
                &references.publisher_public_key,
                &references.index,
                &references.packages,
                &references.include_table,
            )
            .is_err()
        );
        fs::remove_dir(references.references.join("extra")).unwrap();
        fs::remove_dir_all(references.references.join("artifact-test")).unwrap();
        assert!(
            verify_registry_references(
                &references.references,
                &references.metadata,
                &references.root_public_key,
                &references.publisher_public_key,
                &references.index,
                &references.packages,
                &references.include_table,
            )
            .is_err()
        );

        let packages_root = TestDir::new();
        let packages = registry_fixture(&packages_root.0);
        fs::remove_file(&packages.package).unwrap();
        assert!(
            verify_registry_references(
                &packages.references,
                &packages.metadata,
                &packages.root_public_key,
                &packages.publisher_public_key,
                &packages.index,
                &packages.packages,
                &packages.include_table,
            )
            .is_err()
        );
    }

    #[test]
    fn registry_failures_are_bounded_path_and_secret_free() {
        let root = TestDir::new();
        let fixture = registry_fixture(&root.0);
        let marker = "private-registry-path-marker";
        let missing = root.0.join(marker);
        let error = verify_registry_references(
            &fixture.references,
            &missing,
            &fixture.root_public_key,
            &fixture.publisher_public_key,
            &fixture.index,
            &fixture.packages,
            &fixture.include_table,
        )
        .unwrap_err()
        .to_string();
        assert!(!error.contains(marker));
        assert!(!error.contains(&format!("{:02x}", 43).repeat(8)));
        assert!(error.len() < 160);
    }

    #[cfg(unix)]
    #[test]
    fn conventional_package_manager_store_paths_are_rejected_without_commands() {
        let real_roots = conventional_package_store_roots();
        assert!(!real_roots.is_empty());
        for store in real_roots {
            assert_eq!(
                validate_key_location(&store.join("nonexistent-test-key.seed")),
                Err(ArtifactError::KeyUnsafe)
            );
        }

        let root = TestDir::new();
        let home = root.0.join("home");
        let local_app_data = root.0.join("local-app-data");
        let xdg_cache = root.0.join("xdg-cache");
        let xdg_data = root.0.join("xdg-data");
        let cargo_home = root.0.join("cargo-home");
        for base in [&home, &local_app_data, &xdg_cache, &xdg_data, &cargo_home] {
            fs::create_dir(base).unwrap();
        }
        let roots = package_store_roots(
            Some(&home),
            Some(&local_app_data),
            Some(&xdg_cache),
            Some(&xdg_data),
            Some(&cargo_home),
        );
        for store in roots {
            fs::create_dir_all(&store).unwrap();
            let key = store.join("publisher.seed");
            write_key(&key, &[31; 32]);
            let canonical = fs::canonicalize(&key).unwrap();
            assert!(path_is_within_package_store(&canonical, vec![store]));
        }

        for path in [
            home.join(".local/share/pnpm/store/publisher.seed"),
            home.join("Library/pnpm/store/publisher.seed"),
            local_app_data.join("pnpm/store/publisher.seed"),
            xdg_cache.join("npm/publisher.seed"),
            xdg_cache.join("yarn/publisher.seed"),
            xdg_cache.join("bun/publisher.seed"),
            cargo_home.join("registry/publisher.seed"),
        ] {
            assert!(path.exists(), "default-shaped fixture was not created");
        }
    }

    #[cfg(unix)]
    #[test]
    fn key_policy_rejects_mode_symlink_hard_link_checkout_target_and_cache() {
        let root = TestDir::new();
        assert_eq!(
            read_signing_key(&root.0.join("missing.seed")).unwrap_err(),
            ArtifactError::KeyUnavailable
        );
        assert!(matches!(
            read_signing_key(&root.0),
            Err(ArtifactError::KeyUnsafe)
        ));
        let key = root.0.join("key.seed");
        write_key(&key, &[31; 32]);
        assert!(read_signing_key(&key).is_ok());

        let long_key = root.0.join("long.seed");
        write_key(&long_key, &[31; 33]);
        assert_eq!(
            read_signing_key(&long_key).unwrap_err(),
            ArtifactError::KeyLength
        );

        fs::set_permissions(&key, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(matches!(
            read_signing_key(&key),
            Err(ArtifactError::KeyUnsafe)
        ));
        fs::set_permissions(&key, fs::Permissions::from_mode(0o600)).unwrap();

        let link = root.0.join("key-link.seed");
        symlink(&key, &link).unwrap();
        assert!(matches!(
            read_signing_key(&link),
            Err(ArtifactError::KeyUnsafe)
        ));
        fs::remove_file(link).unwrap();

        let hard_link = root.0.join("key-hard.seed");
        fs::hard_link(&key, &hard_link).unwrap();
        assert!(matches!(
            read_signing_key(&key),
            Err(ArtifactError::KeyUnsafe)
        ));
        fs::remove_file(hard_link).unwrap();

        let cache = root.0.join(".cargo");
        fs::create_dir(&cache).unwrap();
        let cache_key = cache.join("key.seed");
        write_key(&cache_key, &[31; 32]);
        assert!(matches!(
            read_signing_key(&cache_key),
            Err(ArtifactError::KeyUnsafe)
        ));

        let checkout_key = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            ".artifact-checkout-key-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        write_key(&checkout_key, &[31; 32]);
        assert!(matches!(
            read_signing_key(&checkout_key),
            Err(ArtifactError::KeyUnsafe)
        ));
        fs::remove_file(checkout_key).unwrap();

        let target_dir = root.0.join("target");
        fs::create_dir(&target_dir).unwrap();
        let target = target_dir.join("key.seed");
        write_key(&target, &[31; 32]);
        assert!(matches!(
            read_signing_key(&target),
            Err(ArtifactError::KeyUnsafe)
        ));

        let evidence_dir = root.0.join("evidence-output");
        fs::create_dir(&evidence_dir).unwrap();
        let evidence_key = evidence_dir.join("key.seed");
        write_key(&evidence_key, &[31; 32]);
        assert!(matches!(
            read_signing_key(&evidence_key),
            Err(ArtifactError::KeyUnsafe)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_signing_fails_closed_while_public_inputs_are_regular_files() {
        let root = TestDir::new();
        let source_path = root.0.join("source.json");
        let component_path = root.0.join("component.wasm");
        let key_path = root.0.join("publisher.seed");
        let output_path = root.0.join("package.jbp");
        fs::write(&source_path, serde_json::to_vec(&source()).unwrap()).unwrap();
        fs::write(
            &component_path,
            include_bytes!("../consumers/rust/rust-consumer.wasm"),
        )
        .unwrap();
        fs::write(&key_path, [23; 32]).unwrap();
        assert_eq!(
            sign_package_artifact(&source_path, &component_path, &key_path, &output_path),
            Err(ArtifactError::KeyPlatformUnsupported)
        );
        assert!(!output_path.exists());

        let public_key_output = root.0.join("publisher-public-key.bin");
        assert_eq!(
            publish_signing_public_key(&key_path, &public_key_output),
            Err(ArtifactError::KeyPlatformUnsupported)
        );
        assert!(!public_key_output.exists());
    }

    #[cfg(unix)]
    #[test]
    fn key_errors_are_bounded_path_and_secret_free() {
        let root = TestDir::new();
        let marker = "private-path-marker";
        let key = root.0.join(marker);
        let secret = [0xabu8; 32];
        write_key(&key, &secret[..31]);
        let error = read_signing_key(&key).unwrap_err().to_string();
        assert!(!error.contains(marker));
        assert!(!error.contains(&format!("{:02x}", secret[0]).repeat(8)));
        assert!(error.len() < 160);
    }
}
