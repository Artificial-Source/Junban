use std::marker::PhantomData;

use ed25519_dalek::SigningKey;

use crate::{
    ChildFrame, ComponentInspection, DependencyLock, GraphError, InstalledPackage,
    PackageInspection, ParentFrame, Permission, PermissionGrantAuthority, RegistryEntry,
    RegistryIndex, RuntimeManifest, SdkError, SignerTrust, SignerTrustRecord, ValidatedGraph,
    VerifiedPackage, VerifiedRegistry, VerifiedSignerAuthority,
};

/// Stable product API names included in the SDK linkage fingerprint. This is a
/// data table only; touching it constructs no parser, engine, process, package,
/// configuration, or heap state.
#[used]
pub static PRODUCT_ENTRYPOINTS: [&str; 10] = [
    "inspect_and_verify_package",
    "inspect_component",
    "pack_package",
    "parse_and_verify_registry",
    "permission_set_hash",
    "validate_dependency_graph",
    "validate_dependency_locks",
    "validate_permission_grants",
    "validate_registry_package_agreement",
    "verify_signer_authority",
];

pub const PRODUCT_ENTRYPOINT_FINGERPRINT: &str =
    "73aca350c915d34de1f555ae935beaa6a262708750784707e37e703856717e7b";

#[used]
static LINKAGE_MARKER: &[u8; 93] =
    b"JUNBAN_PLUGIN_SDK_LINKAGE_V1:73aca350c915d34de1f555ae935beaa6a262708750784707e37e703856717e7b";

pub type ProductInspectEntrypoint = for<'a, 'b, 'c> fn(
    &'a [u8],
    &'b [SignerTrustRecord<'c>],
) -> Result<PackageInspection<'a>, SdkError>;
pub type ProductInspectComponentEntrypoint =
    for<'a, 'b> fn(&'a [u8], &'b RuntimeManifest) -> Result<ComponentInspection, SdkError>;
pub type ProductPackPackageEntrypoint =
    for<'a, 'b, 'c> fn(&'a RuntimeManifest, &'b [u8], &'c SigningKey) -> Result<Vec<u8>, SdkError>;
pub type ProductParseRegistryEntrypoint =
    for<'a, 'b> fn(&'a [u8], &'b [u8; 32]) -> Result<VerifiedRegistry, SdkError>;
pub type ProductPermissionHashEntrypoint =
    for<'a> fn(&'a [Permission]) -> Result<[u8; 32], SdkError>;
pub type ProductValidateGraphEntrypoint =
    for<'a, 'b> fn(&'a [InstalledPackage<'b>]) -> Result<ValidatedGraph, GraphError>;
pub type ProductValidateLocksEntrypoint =
    for<'a, 'b, 'c> fn(&'a [InstalledPackage<'b>], &'c [DependencyLock]) -> Result<(), GraphError>;
pub type ProductValidateGrantsEntrypoint =
    for<'a, 'b> fn(
        &'a [Permission],
        &'b [Permission],
    ) -> Result<PermissionGrantAuthority, SdkError>;
pub type ProductValidateRegistryAgreementEntrypoint =
    for<'a, 'b, 'c> fn(&'a RegistryEntry, &'b VerifiedPackage<'c>) -> Result<(), SdkError>;
pub type ProductVerifySignerEntrypoint =
    for<'a, 'b, 'c, 'd> fn(
        &'a VerifiedPackage<'b>,
        &'c [SignerTrustRecord<'d>],
    ) -> Result<VerifiedSignerAuthority, SdkError>;

/// Executable product SDK authority retained by the default server linkage
/// proof. These pointers reference code only and construct no runtime state.
#[derive(Clone, Copy, Debug)]
pub struct ProductEntrypointFunctions {
    pub inspect_and_verify_package: ProductInspectEntrypoint,
    pub inspect_component: ProductInspectComponentEntrypoint,
    pub pack_package: ProductPackPackageEntrypoint,
    pub parse_and_verify_registry: ProductParseRegistryEntrypoint,
    pub permission_set_hash: ProductPermissionHashEntrypoint,
    pub validate_dependency_graph: ProductValidateGraphEntrypoint,
    pub validate_dependency_locks: ProductValidateLocksEntrypoint,
    pub validate_permission_grants: ProductValidateGrantsEntrypoint,
    pub validate_registry_package_agreement: ProductValidateRegistryAgreementEntrypoint,
    pub verify_signer_authority: ProductVerifySignerEntrypoint,
}

const _: ProductInspectEntrypoint = crate::inspect_and_verify_package;
const _: ProductInspectComponentEntrypoint = crate::inspect_component;
const _: ProductPackPackageEntrypoint = crate::pack_package;
const _: ProductParseRegistryEntrypoint = crate::parse_and_verify_registry;
const _: ProductPermissionHashEntrypoint = crate::permission_set_hash;
const _: ProductValidateGraphEntrypoint = crate::validate_dependency_graph;
const _: ProductValidateLocksEntrypoint = crate::validate_dependency_locks;
const _: ProductValidateGrantsEntrypoint = crate::validate_permission_grants;
const _: ProductValidateRegistryAgreementEntrypoint = crate::validate_registry_package_agreement;
const _: ProductVerifySignerEntrypoint = crate::verify_signer_authority;

#[used]
pub static PRODUCT_ENTRYPOINT_FUNCTIONS: ProductEntrypointFunctions = ProductEntrypointFunctions {
    inspect_and_verify_package: crate::inspect_and_verify_package,
    inspect_component: crate::inspect_component,
    pack_package: crate::pack_package,
    parse_and_verify_registry: crate::parse_and_verify_registry,
    permission_set_hash: crate::permission_set_hash,
    validate_dependency_graph: crate::validate_dependency_graph,
    validate_dependency_locks: crate::validate_dependency_locks,
    validate_permission_grants: crate::validate_permission_grants,
    validate_registry_package_agreement: crate::validate_registry_package_agreement,
    verify_signer_authority: crate::verify_signer_authority,
};

pub type ProductAuthorityTypes = (
    RuntimeManifest,
    ComponentInspection,
    DependencyLock,
    RegistryIndex,
    ParentFrame,
    ChildFrame,
    SignerTrust,
);

const PRODUCT_AUTHORITY_TYPE_SIZES: [usize; 7] = [
    size_of::<RuntimeManifest>(),
    size_of::<ComponentInspection>(),
    size_of::<DependencyLock>(),
    size_of::<RegistryIndex>(),
    size_of::<ParentFrame>(),
    size_of::<ChildFrame>(),
    size_of::<SignerTrust>(),
];

#[derive(Clone, Copy, Debug)]
pub struct ProductLinkageAuthority {
    pub marker: &'static [u8; 93],
    pub entrypoints: &'static [&'static str; 10],
    pub entrypoint_functions: &'static ProductEntrypointFunctions,
    pub fingerprint: &'static str,
    pub authority_type_sizes: &'static [usize; 7],
    pub authority_types: PhantomData<ProductAuthorityTypes>,
}

#[used]
static PRODUCT_LINKAGE_AUTHORITY: ProductLinkageAuthority = ProductLinkageAuthority {
    marker: LINKAGE_MARKER,
    entrypoints: &PRODUCT_ENTRYPOINTS,
    entrypoint_functions: &PRODUCT_ENTRYPOINT_FUNCTIONS,
    fingerprint: PRODUCT_ENTRYPOINT_FINGERPRINT,
    authority_type_sizes: &PRODUCT_AUTHORITY_TYPE_SIZES,
    authority_types: PhantomData,
};

/// Zero-allocation static authority touched by the default server binary so
/// thin LTO cannot erase the product SDK entrypoint table, code, or marker.
#[inline(never)]
#[must_use]
pub fn product_linkage_authority() -> &'static ProductLinkageAuthority {
    &PRODUCT_LINKAGE_AUTHORITY
}

#[inline(never)]
#[must_use]
pub fn product_linkage_marker() -> &'static [u8; 93] {
    product_linkage_authority().marker
}
