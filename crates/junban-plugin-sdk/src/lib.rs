#![forbid(unsafe_code)]

mod authority;
mod component;
mod error;
mod graph;
mod identity;
mod linkage;
mod manifest;
mod package;
mod permission;
mod protocol;
mod registry;
mod util;

#[cfg(test)]
mod tests;
mod trust;

pub use authority::{
    DECLARATION_AUTHORITIES, DeclarationAuthority, DeclarationKind, IMPORT_AUTHORITIES,
    ImportAuthority, OUTCOME_AUTHORITIES, OutcomeAuthority, OutcomeKind, declaration_authority,
    import_authority, outcome_authority,
};
pub use component::{
    COMPONENT_AUTHORITY_METADATA_MAX, COMPONENT_AUTHORITY_METADATA_SECTION_MAX,
    COMPONENT_NESTING_MAX, COMPONENT_SECTIONS_MAX, ComponentInspection, REQUIRED_GUEST_EXPORT,
    RUST_WASI_ABI_SHA256, RUST_WASI_BASELINE, WIT_SOURCE, capability_for_import, inspect_component,
    inspect_component_reader,
};
pub use error::SdkError;
pub use graph::{
    DependencyLock, GraphError, IncompatibleDependency, InstalledPackage, MissingDependency,
    ValidatedGraph, validate_dependency_graph, validate_dependency_locks,
};
pub use identity::{
    PluginId, Sha256Digest, compare_versions, signer_key_id, validate_signer_public_key,
    version_matches,
};
pub use linkage::{
    PRODUCT_ENTRYPOINT_FINGERPRINT, PRODUCT_ENTRYPOINT_FUNCTIONS, PRODUCT_ENTRYPOINTS,
    ProductAuthorityTypes, ProductEntrypointFunctions, ProductInspectComponentEntrypoint,
    ProductInspectEntrypoint, ProductLinkageAuthority, ProductPackPackageEntrypoint,
    ProductParseRegistryEntrypoint, ProductPermissionHashEntrypoint,
    ProductValidateGrantsEntrypoint, ProductValidateGraphEntrypoint,
    ProductValidateLocksEntrypoint, ProductValidateRegistryAgreementEntrypoint,
    ProductVerifySignerEntrypoint, product_linkage_authority, product_linkage_marker,
};
pub use manifest::*;
pub use package::{
    COMPONENT_BYTES_MAX, JBP1_MAGIC, PACKAGE_BYTES_MAX, PackageIdentities, ParsedPackage,
    VerifiedPackage, VerifiedPackageReader, pack_package, parse_package, verify_package,
    verify_package_reader,
};
pub use permission::{
    PERMISSIONS_MAX, PermissionGrantAuthority, permission_set_hash, scope_hash,
    validate_permission_grants,
};
pub use protocol::*;
pub use registry::{
    JRI1_MAGIC, REGISTRY_ENTRIES_MAX, REGISTRY_ENVELOPE_BYTES_MAX, REGISTRY_INDEX_BYTES_MAX,
    RegistryEntry, RegistryIndex, VerifiedRegistry, parse_and_verify_registry,
    registry_package_path, validate_registry_package_agreement,
};
pub use trust::{
    SIGNER_TRUST_RECORDS_MAX, SignerTrust, SignerTrustRecord, VerifiedSignerAuthority,
    verify_signer_authority,
};

#[derive(Clone)]
pub struct PackageInspection<'a> {
    pub package: VerifiedPackage<'a>,
    pub signer: VerifiedSignerAuthority,
    pub component: ComponentInspection,
}

/// Pure full product inspection over caller-owned bytes. It performs no file,
/// network, process, database, server, or Wasmtime operation.
pub fn inspect_and_verify_package<'a>(
    bytes: &'a [u8],
    trust: &[SignerTrustRecord<'_>],
) -> Result<PackageInspection<'a>, SdkError> {
    let package = verify_package(bytes)?;
    let signer = verify_signer_authority(&package, trust)?;
    let component = inspect_component(package.component_bytes, &package.manifest)?;
    Ok(PackageInspection {
        package,
        signer,
        component,
    })
}
