use sha2::{Digest, Sha256};

use crate::{
    error::{Result, SdkError},
    manifest::Permission,
    util::put_u32,
};

const SCOPE_DOMAIN: &[u8] = b"junban.plugin.scope.v1\0";
const SET_DOMAIN: &[u8] = b"junban.plugin.permissions.v1\0";
pub const PERMISSIONS_MAX: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionGrantAuthority {
    pub requested_hash: [u8; 32],
    pub granted_hash: [u8; 32],
}

/// Hash one exact canonical permission scope using the frozen u32be framing.
pub fn scope_hash(permission: &Permission) -> Result<[u8; 32]> {
    crate::manifest::validate_permission(permission)?;
    let scope = serde_json::to_vec(&permission.scope).map_err(|_| SdkError::Permission)?;
    let capability = permission.capability.as_str().as_bytes();
    let mut material = Vec::with_capacity(SCOPE_DOMAIN.len() + capability.len() + scope.len() + 8);
    material.extend_from_slice(SCOPE_DOMAIN);
    put_u32(&mut material, capability.len())?;
    material.extend_from_slice(capability);
    put_u32(&mut material, scope.len())?;
    material.extend_from_slice(&scope);
    Ok(Sha256::digest(&material).into())
}

/// Hash an already canonical, sorted permission set. Duplicate or reordered
/// input is rejected rather than normalized.
pub fn permission_set_hash(permissions: &[Permission]) -> Result<[u8; 32]> {
    if permissions.len() > PERMISSIONS_MAX {
        return Err(SdkError::Permission);
    }
    let mut framed = Vec::with_capacity(SET_DOMAIN.len() + 4 + permissions.len() * 48);
    framed.extend_from_slice(SET_DOMAIN);
    put_u32(&mut framed, permissions.len())?;
    let mut previous: Option<(&[u8], [u8; 32])> = None;
    for permission in permissions {
        let capability = permission.capability.as_str().as_bytes();
        let hash = scope_hash(permission)?;
        if previous.is_some_and(|(old_capability, old_hash)| {
            old_capability
                .cmp(capability)
                .then_with(|| old_hash.cmp(&hash))
                .is_ge()
        }) {
            return Err(SdkError::Permission);
        }
        put_u32(&mut framed, capability.len())?;
        framed.extend_from_slice(capability);
        framed.extend_from_slice(&hash);
        previous = Some((capability, hash));
    }
    Ok(Sha256::digest(&framed).into())
}

/// Validate that grants are a canonical subset of the exact requested
/// permission entries. Scopes cannot be silently broadened or rewritten.
pub fn validate_permission_grants(
    requested: &[Permission],
    granted: &[Permission],
) -> Result<PermissionGrantAuthority> {
    let requested_hash = permission_set_hash(requested)?;
    let granted_hash = permission_set_hash(granted)?;
    let mut requested_index = 0;
    for grant in granted {
        while requested_index < requested.len() && requested[requested_index] != *grant {
            requested_index += 1;
        }
        if requested_index == requested.len() {
            return Err(SdkError::Permission);
        }
        requested_index += 1;
    }
    Ok(PermissionGrantAuthority {
        requested_hash,
        granted_hash,
    })
}
