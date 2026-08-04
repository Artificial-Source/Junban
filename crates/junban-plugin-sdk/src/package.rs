use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::{
    error::{Result, SdkError},
    manifest::RuntimeManifest,
    util::{decode_hex_32, hex, sha256},
};

pub const JBP1_MAGIC: &[u8; 8] = b"JUNBANP1";
pub const COMPONENT_BYTES_MAX: usize = 33_554_432;
pub const PACKAGE_BYTES_MAX: usize = 34_603_008;
const PACKAGE_DOMAIN: &[u8] = b"junban.plugin.package.v1\0";
const FIXED_AFTER_MANIFEST: usize = 32 + 64 + 8;
const HEADER_BYTES: usize = 12;

#[derive(Clone, Copy)]
pub struct ParsedPackage<'a> {
    pub manifest_bytes: &'a [u8],
    pub public_key: &'a [u8; 32],
    pub signature: &'a [u8; 64],
    pub component_bytes: &'a [u8],
    pub envelope_bytes: &'a [u8],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackageIdentities {
    pub package_sha256: String,
    pub manifest_sha256: String,
    pub component_sha256: String,
    pub key_id: String,
    pub package_size: u64,
    pub component_size: u64,
}

#[derive(Clone)]
pub struct VerifiedPackage<'a> {
    pub manifest: RuntimeManifest,
    pub identities: PackageIdentities,
    pub component_bytes: &'a [u8],
}

pub fn parse_package(bytes: &[u8]) -> Result<ParsedPackage<'_>> {
    if bytes.len() > PACKAGE_BYTES_MAX {
        return Err(SdkError::Length { field: "package" });
    }
    if bytes.len() < HEADER_BYTES {
        return Err(SdkError::Truncated { format: "JBP1" });
    }
    if &bytes[..8] != JBP1_MAGIC {
        return Err(SdkError::Magic { format: "JBP1" });
    }
    let manifest_len = usize::try_from(u32::from_be_bytes(
        bytes[8..12]
            .try_into()
            .map_err(|_| SdkError::Truncated { format: "JBP1" })?,
    ))
    .map_err(|_| SdkError::Length { field: "manifest" })?;
    if manifest_len == 0 || manifest_len > crate::manifest::MANIFEST_BYTES_MAX {
        return Err(SdkError::Length { field: "manifest" });
    }
    let manifest_end = HEADER_BYTES
        .checked_add(manifest_len)
        .ok_or(SdkError::Length { field: "package" })?;
    let component_len_offset = manifest_end
        .checked_add(32 + 64)
        .ok_or(SdkError::Length { field: "package" })?;
    let fixed_end = component_len_offset
        .checked_add(8)
        .ok_or(SdkError::Length { field: "package" })?;
    if bytes.len() < fixed_end {
        return Err(SdkError::Truncated { format: "JBP1" });
    }
    let component_len_u64 = u64::from_be_bytes(
        bytes[component_len_offset..fixed_end]
            .try_into()
            .map_err(|_| SdkError::Truncated { format: "JBP1" })?,
    );
    let component_len =
        usize::try_from(component_len_u64).map_err(|_| SdkError::Length { field: "component" })?;
    if component_len == 0 || component_len > COMPONENT_BYTES_MAX {
        return Err(SdkError::Length { field: "component" });
    }
    let expected = fixed_end
        .checked_add(component_len)
        .ok_or(SdkError::Length { field: "package" })?;
    if expected > PACKAGE_BYTES_MAX {
        return Err(SdkError::Length { field: "package" });
    }
    if bytes.len() < expected {
        return Err(SdkError::Truncated { format: "JBP1" });
    }
    if bytes.len() != expected {
        return Err(SdkError::Trailing { format: "JBP1" });
    }
    let public_key: &[u8; 32] = bytes[manifest_end..manifest_end + 32]
        .try_into()
        .map_err(|_| SdkError::Truncated { format: "JBP1" })?;
    let signature: &[u8; 64] = bytes[manifest_end + 32..component_len_offset]
        .try_into()
        .map_err(|_| SdkError::Truncated { format: "JBP1" })?;
    Ok(ParsedPackage {
        manifest_bytes: &bytes[HEADER_BYTES..manifest_end],
        public_key,
        signature,
        component_bytes: &bytes[fixed_end..expected],
        envelope_bytes: bytes,
    })
}

pub fn verify_package(bytes: &[u8]) -> Result<VerifiedPackage<'_>> {
    let parsed = parse_package(bytes)?;
    let manifest = RuntimeManifest::parse_canonical(parsed.manifest_bytes)?;
    let manifest_hash = sha256(parsed.manifest_bytes);
    let component_hash = sha256(parsed.component_bytes);
    if decode_hex_32(&manifest.component_sha256, "component_sha256")? != component_hash {
        return Err(SdkError::Identity {
            field: "component_sha256",
        });
    }
    let key_hash = sha256(parsed.public_key);
    if decode_hex_32(&manifest.publisher.key_id, "publisher.key_id")? != key_hash {
        return Err(SdkError::Identity {
            field: "publisher.key_id",
        });
    }
    let key = VerifyingKey::from_bytes(parsed.public_key).map_err(|_| SdkError::Signature)?;
    let mut message = Vec::with_capacity(PACKAGE_DOMAIN.len() + 64);
    message.extend_from_slice(PACKAGE_DOMAIN);
    message.extend_from_slice(&manifest_hash);
    message.extend_from_slice(&component_hash);
    key.verify_strict(&message, &Signature::from_bytes(parsed.signature))
        .map_err(|_| SdkError::Signature)?;
    Ok(VerifiedPackage {
        manifest,
        identities: PackageIdentities {
            package_sha256: hex(&sha256(parsed.envelope_bytes)),
            manifest_sha256: hex(&manifest_hash),
            component_sha256: hex(&component_hash),
            key_id: hex(&key_hash),
            package_size: u64::try_from(parsed.envelope_bytes.len())
                .map_err(|_| SdkError::Length { field: "package" })?,
            component_size: u64::try_from(parsed.component_bytes.len())
                .map_err(|_| SdkError::Length { field: "component" })?,
        },
        component_bytes: parsed.component_bytes,
    })
}

/// Deterministically serialize and sign one package. The caller owns key
/// custody; the SDK neither creates nor persists signing keys.
pub fn pack_package(
    manifest: &RuntimeManifest,
    component_bytes: &[u8],
    signing_key: &SigningKey,
) -> Result<Vec<u8>> {
    if component_bytes.is_empty() || component_bytes.len() > COMPONENT_BYTES_MAX {
        return Err(SdkError::Length { field: "component" });
    }
    let manifest_bytes = manifest.canonical_bytes()?;
    let component_hash = sha256(component_bytes);
    if decode_hex_32(&manifest.component_sha256, "component_sha256")? != component_hash {
        return Err(SdkError::Identity {
            field: "component_sha256",
        });
    }
    let public_key = signing_key.verifying_key().to_bytes();
    if decode_hex_32(&manifest.publisher.key_id, "publisher.key_id")? != sha256(&public_key) {
        return Err(SdkError::Identity {
            field: "publisher.key_id",
        });
    }
    let manifest_hash = sha256(&manifest_bytes);
    let mut message = Vec::with_capacity(PACKAGE_DOMAIN.len() + 64);
    message.extend_from_slice(PACKAGE_DOMAIN);
    message.extend_from_slice(&manifest_hash);
    message.extend_from_slice(&component_hash);
    let signature = signing_key.sign(&message).to_bytes();
    let capacity = HEADER_BYTES
        .checked_add(manifest_bytes.len())
        .and_then(|value| value.checked_add(FIXED_AFTER_MANIFEST))
        .and_then(|value| value.checked_add(component_bytes.len()))
        .ok_or(SdkError::Length { field: "package" })?;
    if capacity > PACKAGE_BYTES_MAX {
        return Err(SdkError::Length { field: "package" });
    }
    let mut package = Vec::with_capacity(capacity);
    package.extend_from_slice(JBP1_MAGIC);
    package.extend_from_slice(
        &u32::try_from(manifest_bytes.len())
            .map_err(|_| SdkError::Length { field: "manifest" })?
            .to_be_bytes(),
    );
    package.extend_from_slice(&manifest_bytes);
    package.extend_from_slice(&public_key);
    package.extend_from_slice(&signature);
    package.extend_from_slice(
        &u64::try_from(component_bytes.len())
            .map_err(|_| SdkError::Length { field: "component" })?
            .to_be_bytes(),
    );
    package.extend_from_slice(component_bytes);
    Ok(package)
}
