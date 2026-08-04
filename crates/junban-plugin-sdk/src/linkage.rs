use std::marker::PhantomData;

use crate::{
    ChildFrame, ComponentInspection, DependencyLock, PackageInspection, ParentFrame, RegistryIndex,
    RuntimeManifest, SdkError, SignerTrust, SignerTrustRecord,
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
pub type ProductAuthorityTypes = (
    RuntimeManifest,
    ComponentInspection,
    DependencyLock,
    RegistryIndex,
    ParentFrame,
    ChildFrame,
    SignerTrust,
);

const _: ProductInspectEntrypoint = crate::inspect_and_verify_package;
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
    pub fingerprint: &'static str,
    pub authority_type_sizes: &'static [usize; 7],
    pub authority_types: PhantomData<ProductAuthorityTypes>,
}

#[used]
static PRODUCT_LINKAGE_AUTHORITY: ProductLinkageAuthority = ProductLinkageAuthority {
    marker: LINKAGE_MARKER,
    entrypoints: &PRODUCT_ENTRYPOINTS,
    fingerprint: PRODUCT_ENTRYPOINT_FINGERPRINT,
    authority_type_sizes: &PRODUCT_AUTHORITY_TYPE_SIZES,
    authority_types: PhantomData,
};

/// Zero-allocation static authority touched by the default server binary so
/// thin LTO cannot erase the product SDK entrypoint table or linkage marker.
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
