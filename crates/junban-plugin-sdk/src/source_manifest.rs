use serde::{Deserialize, Serialize};

use crate::{
    error::{Result, SdkError},
    manifest::{
        CommandDeclaration, Dependency, EventKind, MANIFEST_BYTES_MAX, Permission, RuntimeManifest,
        RuntimeProfile, ServiceDeclaration, SettingDeclaration, SurfaceDeclaration, WitAuthority,
    },
    util::{hex, sha256},
};

/// Schema-v1 author input used to derive a signed [`RuntimeManifest`].
///
/// This format deliberately excludes the publisher key identifier and component
/// digest: both are derived from the exact signing public key and component
/// bytes rather than trusted from author-controlled JSON.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub publisher: SourcePublisher,
    pub license: String,
    pub junban_compatibility: String,
    pub wit: WitAuthority,
    pub runtime_profile: RuntimeProfile,
    pub permissions: Vec<Permission>,
    pub dependencies: Vec<Dependency>,
    pub commands: Vec<CommandDeclaration>,
    pub subscriptions: Vec<EventKind>,
    pub surfaces: Vec<SurfaceDeclaration>,
    pub settings: Vec<SettingDeclaration>,
    pub services: Vec<ServiceDeclaration>,
}

/// Publisher identity present in author source manifests.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourcePublisher {
    pub id: String,
    pub name: String,
}

impl SourceManifest {
    /// Parse and validate a bounded source manifest.
    ///
    /// Author source JSON need not use runtime canonical whitespace, but unknown,
    /// duplicate, and runtime-derived fields are rejected.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MANIFEST_BYTES_MAX {
            return Err(SdkError::Length {
                field: "source manifest",
            });
        }
        let source = serde_json::from_slice(bytes).map_err(|_| SdkError::CanonicalJson)?;
        Self::validate(&source)?;
        Ok(source)
    }

    /// Validate author-controlled fields through the runtime-manifest authority.
    pub fn validate(&self) -> Result<()> {
        self.runtime_manifest([0; 32], [0; 32]).validate()
    }

    /// Derive and validate the canonical runtime manifest for exact component
    /// bytes and an exact 32-byte Ed25519 publisher public key.
    pub fn derive_runtime_manifest(
        &self,
        component_bytes: &[u8],
        publisher_public_key: &[u8; 32],
    ) -> Result<RuntimeManifest> {
        if component_bytes.is_empty() || component_bytes.len() > crate::package::COMPONENT_BYTES_MAX
        {
            return Err(SdkError::Length { field: "component" });
        }
        crate::identity::validate_signer_public_key(publisher_public_key)?;
        let runtime = self.runtime_manifest(sha256(component_bytes), sha256(publisher_public_key));
        runtime.validate()?;

        // Exercise the one canonical runtime serializer and require its typed
        // reparse to preserve every field exactly before returning authority.
        let canonical = runtime.canonical_bytes()?;
        let reparsed = RuntimeManifest::parse_canonical(&canonical)?;
        if reparsed != runtime {
            return Err(SdkError::CanonicalJson);
        }
        Ok(reparsed)
    }

    fn runtime_manifest(
        &self,
        component_sha256: [u8; 32],
        publisher_key_id: [u8; 32],
    ) -> RuntimeManifest {
        RuntimeManifest {
            schema_version: self.schema_version,
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            version: self.version.clone(),
            publisher: crate::manifest::Publisher {
                id: self.publisher.id.clone(),
                name: self.publisher.name.clone(),
                key_id: hex(&publisher_key_id),
            },
            license: self.license.clone(),
            junban_compatibility: self.junban_compatibility.clone(),
            wit: self.wit.clone(),
            runtime_profile: self.runtime_profile,
            component_sha256: hex(&component_sha256),
            permissions: self.permissions.clone(),
            dependencies: self.dependencies.clone(),
            commands: self.commands.clone(),
            subscriptions: self.subscriptions.clone(),
            surfaces: self.surfaces.clone(),
            settings: self.settings.clone(),
            services: self.services.clone(),
        }
    }
}

/// Derive one canonical runtime manifest from typed author input and exact
/// component/public-key bytes.
pub fn derive_runtime_manifest(
    source: &SourceManifest,
    component_bytes: &[u8],
    publisher_public_key: &[u8; 32],
) -> Result<RuntimeManifest> {
    source.derive_runtime_manifest(component_bytes, publisher_public_key)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::*;
    use crate::manifest::MANIFEST_SCHEMA_VERSION;

    fn source() -> SourceManifest {
        SourceManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            id: "source-test".into(),
            name: "Source test".into(),
            description: "Deterministic source authority".into(),
            version: "1.0.0".into(),
            publisher: SourcePublisher {
                id: "source-publisher".into(),
                name: "Source Publisher".into(),
            },
            license: "MIT".into(),
            junban_compatibility: "^0.1".into(),
            wit: WitAuthority {
                package: "junban:plugin".into(),
                world: "plugin".into(),
                version: "0.1.0".into(),
            },
            runtime_profile: RuntimeProfile::Typescript,
            permissions: Vec::new(),
            dependencies: Vec::new(),
            commands: Vec::new(),
            subscriptions: Vec::new(),
            surfaces: Vec::new(),
            settings: Vec::new(),
            services: Vec::new(),
        }
    }

    #[test]
    fn source_derivation_is_deterministic_and_binds_component_and_key() {
        let source = source();
        let component = b"component";
        let public_key = SigningKey::from_bytes(&[5; 32]).verifying_key().to_bytes();
        let first = source
            .derive_runtime_manifest(component, &public_key)
            .unwrap();
        let second = derive_runtime_manifest(&source, component, &public_key).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.canonical_bytes().unwrap(),
            second.canonical_bytes().unwrap()
        );
        assert_eq!(first.component_sha256, hex(&sha256(component)));
        assert_eq!(first.publisher.key_id, hex(&sha256(&public_key)));

        let mut changed_component = component.to_vec();
        changed_component[0] ^= 1;
        assert_ne!(
            first.component_sha256,
            source
                .derive_runtime_manifest(&changed_component, &public_key)
                .unwrap()
                .component_sha256
        );
        let changed_key = SigningKey::from_bytes(&[6; 32]).verifying_key().to_bytes();
        assert_ne!(
            first.publisher.key_id,
            source
                .derive_runtime_manifest(component, &changed_key)
                .unwrap()
                .publisher
                .key_id
        );
    }

    #[test]
    fn source_parse_rejects_unknown_duplicate_and_derived_fields() {
        let bytes = serde_json::to_vec(&source()).unwrap();
        let json = String::from_utf8(bytes).unwrap();
        let cases = [
            json.replacen('{', "{\"unknown\":true,", 1),
            json.replacen(
                "\"schema_version\":1",
                "\"schema_version\":1,\"schema_version\":1",
                1,
            ),
            json.replacen(
                "\"publisher\":{",
                &format!(
                    "\"component_sha256\":\"{}\",\"publisher\":{{",
                    "0".repeat(64)
                ),
                1,
            ),
            json.replacen(
                "\"name\":\"Source Publisher\"",
                &format!(
                    "\"name\":\"Source Publisher\",\"key_id\":\"{}\"",
                    "0".repeat(64)
                ),
                1,
            ),
        ];
        for case in cases {
            assert!(
                SourceManifest::parse(case.as_bytes()).is_err(),
                "accepted {case}"
            );
        }
    }

    #[test]
    fn source_parse_is_bounded_and_uses_runtime_validation() {
        assert!(matches!(
            SourceManifest::parse(&[]),
            Err(SdkError::Length {
                field: "source manifest"
            })
        ));
        let mut invalid = source();
        invalid.id = "NOT-CANONICAL".into();
        assert!(SourceManifest::parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
}
