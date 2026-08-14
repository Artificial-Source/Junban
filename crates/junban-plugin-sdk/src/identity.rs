//! Canonical plugin identifiers and digest value objects shared by product layers.

use std::{cmp::Ordering, fmt, str::FromStr};

use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

use crate::{
    SdkError,
    util::{decode_hex_32, hex, is_canonical_id, sha256},
};

/// Canonical manifest/plugin identifier (`[a-z0-9]+(?:-[a-z0-9]+)*`, 1..=64 bytes).
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct PluginId(String);

impl PluginId {
    pub fn parse(value: impl Into<String>) -> Result<Self, SdkError> {
        let value = value.into();
        if is_canonical_id(&value) {
            Ok(Self(value))
        } else {
            Err(SdkError::Manifest { field: "id" })
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for PluginId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for PluginId {
    type Err = SdkError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for PluginId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PluginId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

/// Canonical lowercase SHA-256 digest.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn parse(value: impl Into<String>) -> Result<Self, SdkError> {
        let value = value.into();
        decode_hex_32(&value, "sha256")?;
        Ok(Self(value))
    }

    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        Self(hex(&sha256(bytes)))
    }

    #[must_use]
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(hex(&bytes))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn into_string(self) -> String {
        self.0
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl FromStr for Sha256Digest {
    type Err = SdkError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for Sha256Digest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

/// Derive the exact publisher key identity used by signed packages.
#[must_use]
pub fn signer_key_id(public_key: &[u8; 32]) -> Sha256Digest {
    Sha256Digest::of(public_key)
}

/// Validate an Ed25519 publisher key before admitting local trust authority.
pub fn validate_signer_public_key(public_key: &[u8; 32]) -> Result<Sha256Digest, SdkError> {
    VerifyingKey::from_bytes(public_key).map_err(|_| SdkError::Signature)?;
    Ok(signer_key_id(public_key))
}

/// Compare two already-canonical semantic versions through the SDK authority.
pub fn compare_versions(left: &str, right: &str) -> Result<Ordering, SdkError> {
    let parsed_left =
        semver::Version::parse(left).map_err(|_| SdkError::Manifest { field: "version" })?;
    let parsed_right =
        semver::Version::parse(right).map_err(|_| SdkError::Manifest { field: "version" })?;
    if parsed_left.to_string() != left || parsed_right.to_string() != right {
        return Err(SdkError::Manifest { field: "version" });
    }
    Ok(parsed_left.cmp(&parsed_right))
}

/// Test a canonical semantic version against a canonical manifest requirement.
pub fn version_matches(requirement: &str, version: &str) -> Result<bool, SdkError> {
    let raw_requirement = requirement;
    let raw_version = version;
    let requirement =
        semver::VersionReq::parse(raw_requirement).map_err(|_| SdkError::Manifest {
            field: "compatibility",
        })?;
    let version =
        semver::Version::parse(raw_version).map_err(|_| SdkError::Manifest { field: "version" })?;
    if requirement.to_string() != raw_requirement {
        return Err(SdkError::Manifest {
            field: "compatibility",
        });
    }
    if version.to_string() != raw_version {
        return Err(SdkError::Manifest { field: "version" });
    }
    Ok(requirement.matches(&version))
}
