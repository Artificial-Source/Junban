use std::io::Cursor;

use super::*;
use crate::util::{hex, sha256};
use ed25519_dalek::{Signer, SigningKey};
use proptest::prelude::*;

const TEST_KEY_BYTES: [u8; 32] = [7; 32];
const ROOT_KEY_BYTES: [u8; 32] = [11; 32];

fn test_key() -> SigningKey {
    SigningKey::from_bytes(&TEST_KEY_BYTES)
}
fn root_key() -> SigningKey {
    SigningKey::from_bytes(&ROOT_KEY_BYTES)
}

fn valid_component() -> Vec<u8> {
    include_bytes!("../consumers/rust/rust-consumer.wasm").to_vec()
}

fn consumer_permissions() -> Vec<Permission> {
    [
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
    .collect()
}

fn replace_all_equal(bytes: &mut [u8], from: &[u8], to: &[u8]) {
    assert_eq!(from.len(), to.len());
    let mut offset = 0;
    while let Some(index) = bytes[offset..]
        .windows(from.len())
        .position(|candidate| candidate == from)
    {
        let start = offset + index;
        bytes[start..start + from.len()].copy_from_slice(to);
        offset = start + from.len();
    }
}

fn leb(mut value: usize, output: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        output.push(byte);
        if value == 0 {
            break;
        }
    }
}

fn append_custom_section(component: &mut Vec<u8>, name: &str, data_len: usize) {
    component.push(0);
    leb(1 + name.len() + data_len, component);
    component.push(u8::try_from(name.len()).unwrap());
    component.extend_from_slice(name.as_bytes());
    component.resize(component.len() + data_len, 0);
}

fn append_name_section(component: &mut Vec<u8>, data_len: usize) {
    append_custom_section(component, "name", data_len);
}

fn nested_component(depth: usize) -> Vec<u8> {
    let mut component = b"\0asm\x0d\0\x01\0".to_vec();
    for _ in 0..depth {
        let child = component;
        component = b"\0asm\x0d\0\x01\0".to_vec();
        component.push(4);
        leb(child.len(), &mut component);
        component.extend_from_slice(&child);
    }
    component
}

fn component_with_custom_sections(count: usize) -> Vec<u8> {
    let mut component = b"\0asm\x0d\0\x01\0".to_vec();
    for _ in 0..count {
        component.extend_from_slice(&[0, 1, 0]);
    }
    component
}

fn valid_manifest(component: &[u8]) -> RuntimeManifest {
    let key = test_key().verifying_key().to_bytes();
    RuntimeManifest {
        schema_version: 1,
        id: "test-plugin".into(),
        name: "Test plugin".into(),
        description: "Deterministic test package".into(),
        version: "1.0.0".into(),
        publisher: Publisher {
            id: "test-publisher".into(),
            name: "Test Publisher".into(),
            key_id: hex(&sha256(&key)),
        },
        license: "MIT".into(),
        junban_compatibility: "^0.1".into(),
        wit: WitAuthority {
            package: "junban:plugin".into(),
            world: "plugin".into(),
            version: "0.1.0".into(),
        },
        runtime_profile: RuntimeProfile::Typescript,
        component_sha256: hex(&sha256(component)),
        permissions: Vec::new(),
        dependencies: Vec::new(),
        commands: Vec::new(),
        subscriptions: Vec::new(),
        surfaces: Vec::new(),
        settings: Vec::new(),
        services: Vec::new(),
    }
}

fn consumer_manifest(component: &[u8], profile: RuntimeProfile) -> RuntimeManifest {
    let mut manifest = valid_manifest(component);
    manifest.runtime_profile = profile;
    manifest.permissions = consumer_permissions();
    manifest
}

fn valid_package() -> Vec<u8> {
    let component = valid_component();
    pack_package(
        &consumer_manifest(&component, RuntimeProfile::Rust),
        &component,
        &test_key(),
    )
    .unwrap()
}

fn registry_envelope(index: &RegistryIndex, key: &SigningKey) -> Vec<u8> {
    let bytes = serde_json::to_vec(index).unwrap();
    let mut message = b"junban.plugin.registry.v1\0".to_vec();
    message.extend_from_slice(&sha256(&bytes));
    let signature = key.sign(&message).to_bytes();
    let mut envelope = JRI1_MAGIC.to_vec();
    envelope.extend_from_slice(&u32::try_from(bytes.len()).unwrap().to_be_bytes());
    envelope.extend_from_slice(&bytes);
    envelope.extend_from_slice(&signature);
    envelope
}

fn valid_registry_entry(package: &VerifiedPackage<'_>) -> RegistryEntry {
    RegistryEntry {
        plugin_id: package.manifest.id.clone(),
        version: package.manifest.version.clone(),
        package_sha256: package.identities.package_sha256.clone(),
        package_size: package.identities.package_size,
        publisher_key_id: package.identities.key_id.clone(),
        name: package.manifest.name.clone(),
        description: package.manifest.description.clone(),
        author: "Test Publisher".into(),
        license: package.manifest.license.clone(),
        search_tags: vec!["tasks".into()],
        runtime_profile: package.manifest.runtime_profile,
        requested_capabilities: package
            .manifest
            .permissions
            .iter()
            .map(|permission| permission.capability)
            .collect(),
        filename: registry_package_path(&package.identities.package_sha256).unwrap(),
    }
}

#[test]
fn exact_wit_parses_and_valid_component_has_structural_guest_abi() {
    let component = valid_component();
    assert_eq!(
        hex(&sha256(WIT_SOURCE.as_bytes())),
        "5705801973219a0e6981693653f2caefdf1090345b65494750c8d8a9bf4b15f4"
    );
    assert_eq!(
        hex(&sha256(&component)),
        "0bd13500bddde8baecd79a974a3f32951c13b187b2e22eeb07ae8b51a536d0e1"
    );
    let inspection = inspect_component(
        &component,
        &consumer_manifest(&component, RuntimeProfile::Rust),
    )
    .unwrap();
    assert_eq!(
        inspection.imports,
        [
            "junban:plugin/host-log@0.1.0",
            "junban:plugin/host-settings@0.1.0",
            "junban:plugin/host-storage@0.1.0",
            "junban:plugin/host-tasks@0.1.0",
            "junban:plugin/types@0.1.0",
            "wasi:cli/environment@0.2.6",
            "wasi:cli/exit@0.2.6",
            "wasi:cli/stderr@0.2.6",
            "wasi:io/error@0.2.6",
            "wasi:io/streams@0.2.6",
        ]
    );
    assert_eq!(inspection.exports, [REQUIRED_GUEST_EXPORT]);
    assert_eq!(inspection.guest_abi_sha256.len(), 64);
    let grants = consumer_permissions();
    assert_eq!(
        inspect_component_for_runtime(&component, RuntimeProfile::Rust, &grants)
            .unwrap()
            .import_export_fingerprint,
        inspection.import_export_fingerprint
    );
    assert_eq!(
        inspect_component_for_runtime(&component, RuntimeProfile::Rust, &grants[..3]),
        Err(SdkError::Permission)
    );
    assert!(matches!(
        inspect_component_for_runtime(&component, RuntimeProfile::Typescript, &grants),
        Err(SdkError::ComponentAuthority {
            field: "runtime profile imports"
        })
    ));

    let typescript = include_bytes!("../consumers/typescript/artifacts/typescript-consumer.wasm");
    assert!(typescript.len() <= COMPONENT_BYTES_MAX);
    let typescript_manifest = consumer_manifest(typescript, RuntimeProfile::Typescript);
    let typescript_inspection = inspect_component(typescript, &typescript_manifest).unwrap();
    assert_eq!(
        typescript_inspection.imports,
        [
            "junban:plugin/host-log@0.1.0",
            "junban:plugin/host-settings@0.1.0",
            "junban:plugin/host-storage@0.1.0",
            "junban:plugin/host-tasks@0.1.0",
            "junban:plugin/types@0.1.0",
        ]
    );
    assert_eq!(
        typescript_inspection.guest_abi_sha256,
        inspection.guest_abi_sha256
    );
    let typescript_package = pack_package(&typescript_manifest, typescript, &test_key()).unwrap();
    assert!(typescript_package.len() <= PACKAGE_BYTES_MAX);
    assert_eq!(
        verify_package(&typescript_package).unwrap().component_bytes,
        typescript
    );
}

#[test]
fn deterministic_valid_package_round_trips_and_full_inspects() {
    let first = valid_package();
    let second = valid_package();
    assert_eq!(first, second);
    assert_eq!(
        hex(&sha256(&first)),
        "58c12ca50250b4fdae03b37477b534f60a1f4fe0f8e5fee85c49d9c954477662"
    );
    let expected_key_id = hex(&sha256(&test_key().verifying_key().to_bytes()));
    let local_trust = [SignerTrustRecord {
        key_id: &expected_key_id,
        trust: SignerTrust::LocalExplicit,
    }];
    let inspection = inspect_and_verify_package(&first, &local_trust).unwrap();
    assert_eq!(inspection.signer.trust, SignerTrust::LocalExplicit);
    assert_eq!(inspection.package.manifest.id, "test-plugin");
    assert_eq!(
        inspection.package.identities.package_sha256,
        hex(&sha256(&first))
    );
    assert!(matches!(
        inspect_and_verify_package(&first, &[]),
        Err(SdkError::UnknownSigner)
    ));
    let revoked = [SignerTrustRecord {
        key_id: &expected_key_id,
        trust: SignerTrust::Revoked,
    }];
    assert!(matches!(
        inspect_and_verify_package(&first, &revoked),
        Err(SdkError::RevokedSigner)
    ));
    let bundled = [SignerTrustRecord {
        key_id: &expected_key_id,
        trust: SignerTrust::BundledRegistry,
    }];
    assert_eq!(
        inspect_and_verify_package(&first, &bundled)
            .unwrap()
            .signer
            .trust,
        SignerTrust::BundledRegistry
    );
    assert!(matches!(
        inspect_and_verify_package(
            &first,
            &[
                SignerTrustRecord {
                    key_id: &expected_key_id,
                    trust: SignerTrust::LocalExplicit,
                },
                SignerTrustRecord {
                    key_id: &expected_key_id,
                    trust: SignerTrust::Revoked,
                },
            ]
        ),
        Err(SdkError::TrustPolicy)
    ));
    assert!(matches!(
        inspect_and_verify_package(
            &first,
            &[SignerTrustRecord {
                key_id: "not-a-key-id",
                trust: SignerTrust::LocalExplicit,
            }]
        ),
        Err(SdkError::TrustPolicy)
    ));
    let oversized_policy = vec![
        SignerTrustRecord {
            key_id: &expected_key_id,
            trust: SignerTrust::LocalExplicit,
        };
        SIGNER_TRUST_RECORDS_MAX + 1
    ];
    assert!(matches!(
        inspect_and_verify_package(&first, &oversized_policy),
        Err(SdkError::TrustPolicy)
    ));
}

#[test]
fn seekable_package_verification_matches_bytes_and_rejects_claimed_bounds() {
    let bytes = valid_package();
    let expected = verify_package(&bytes).unwrap();
    let mut reader = Cursor::new(bytes.clone());
    let streamed = verify_package_reader(&mut reader, bytes.len() as u64).unwrap();
    assert_eq!(streamed.manifest, expected.manifest);
    assert_eq!(streamed.identities, expected.identities);
    assert_eq!(
        streamed.publisher_public_key,
        *parse_package(&bytes).unwrap().public_key
    );

    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(matches!(
        verify_package_reader(&mut Cursor::new(trailing.clone()), trailing.len() as u64),
        Err(SdkError::Trailing { format: "JBP1" })
    ));
    assert!(matches!(
        verify_package_reader(
            &mut Cursor::new(bytes.clone()),
            bytes.len().saturating_sub(1) as u64,
        ),
        Err(SdkError::Truncated { format: "JBP1" })
    ));
    assert!(matches!(
        verify_package_reader(
            &mut Cursor::new(Vec::<u8>::new()),
            PACKAGE_BYTES_MAX as u64 + 1,
        ),
        Err(SdkError::Length { field: "package" })
    ));
}

#[test]
fn jbp1_rejects_magic_lengths_truncation_trailing_and_oversize() {
    let valid = valid_package();
    let mut wrong_magic = valid.clone();
    wrong_magic[0] ^= 1;
    assert!(matches!(
        parse_package(&wrong_magic),
        Err(SdkError::Magic { .. })
    ));
    for length in 0..12 {
        assert!(parse_package(&valid[..length]).is_err());
    }
    let mut zero_manifest = valid.clone();
    zero_manifest[8..12].copy_from_slice(&0_u32.to_be_bytes());
    assert!(matches!(
        parse_package(&zero_manifest),
        Err(SdkError::Length { field: "manifest" })
    ));
    let mut huge_manifest = valid.clone();
    huge_manifest[8..12].copy_from_slice(&65_537_u32.to_be_bytes());
    assert!(matches!(
        parse_package(&huge_manifest),
        Err(SdkError::Length { field: "manifest" })
    ));
    let manifest_len = u32::from_be_bytes(valid[8..12].try_into().unwrap()) as usize;
    let component_length_offset = 12 + manifest_len + 32 + 64;
    let mut zero_component = valid.clone();
    zero_component[component_length_offset..component_length_offset + 8]
        .copy_from_slice(&0_u64.to_be_bytes());
    assert!(matches!(
        parse_package(&zero_component),
        Err(SdkError::Length { field: "component" })
    ));
    let mut huge_component = valid.clone();
    huge_component[component_length_offset..component_length_offset + 8].copy_from_slice(
        &u64::try_from(COMPONENT_BYTES_MAX + 1)
            .unwrap()
            .to_be_bytes(),
    );
    assert!(matches!(
        parse_package(&huge_component),
        Err(SdkError::Length { field: "component" })
    ));
    assert!(matches!(
        parse_package(&valid[..valid.len() - 1]),
        Err(SdkError::Truncated { .. })
    ));
    let mut trailing = valid.clone();
    trailing.push(0);
    assert!(matches!(
        parse_package(&trailing),
        Err(SdkError::Trailing { .. })
    ));
    assert!(matches!(
        parse_package(&vec![0; PACKAGE_BYTES_MAX + 1]),
        Err(SdkError::Length { field: "package" })
    ));
}

#[test]
fn jbp1_rejects_noncanonical_unknown_duplicate_float_and_whitespace_manifest() {
    let component = valid_component();
    let manifest = valid_manifest(&component);
    let canonical = manifest.canonical_bytes().unwrap();
    let object = String::from_utf8(canonical.clone()).unwrap();
    let variants = [
        object.replacen("{", "{\"unknown\":1,", 1),
        object.replacen(
            "\"schema_version\":1",
            "\"schema_version\":1,\"schema_version\":1",
            1,
        ),
        object.replacen("\"schema_version\":1", "\"schema_version\":1.0", 1),
        format!(" {object}"),
        format!("{object}\n"),
    ];
    for variant in variants {
        assert!(RuntimeManifest::parse_canonical(variant.as_bytes()).is_err());
    }
}

#[test]
fn package_rejects_component_hash_key_signature_domain_and_wrong_key() {
    let valid = valid_package();
    let parsed = parse_package(&valid).unwrap();
    let manifest_offset = 12;
    let manifest_end = manifest_offset + parsed.manifest_bytes.len();
    let mut component_changed = valid.clone();
    *component_changed.last_mut().unwrap() ^= 1;
    assert!(matches!(
        verify_package(&component_changed),
        Err(SdkError::Identity {
            field: "component_sha256"
        })
    ));
    let mut key_changed = valid.clone();
    key_changed[manifest_end] ^= 1;
    assert!(matches!(
        verify_package(&key_changed),
        Err(SdkError::Identity {
            field: "publisher.key_id"
        }) | Err(SdkError::Signature)
    ));
    let mut signature_changed = valid.clone();
    signature_changed[manifest_end + 32] ^= 1;
    assert!(matches!(
        verify_package(&signature_changed),
        Err(SdkError::Signature)
    ));

    let mut wrong_domain = valid.clone();
    let wrong_signature = test_key().sign(b"junban.plugin.package.v0\0").to_bytes();
    wrong_domain[manifest_end + 32..manifest_end + 96].copy_from_slice(&wrong_signature);
    assert!(matches!(
        verify_package(&wrong_domain),
        Err(SdkError::Signature)
    ));

    let mut wrong_key = valid.clone();
    let replacement = SigningKey::from_bytes(&[9; 32]).verifying_key().to_bytes();
    wrong_key[manifest_end..manifest_end + 32].copy_from_slice(&replacement);
    assert!(verify_package(&wrong_key).is_err());
}

#[test]
fn manifest_rejects_ids_text_semver_license_runtime_and_wit_authority() {
    let component = valid_component();
    let base = valid_manifest(&component);
    let mut cases = Vec::new();
    let mut value = base.clone();
    value.id = "Bad_Id".into();
    cases.push(value);
    let mut value = base.clone();
    value.name = "x".repeat(129);
    cases.push(value);
    let mut value = base.clone();
    value.description = "bad\u{202e}text".into();
    cases.push(value);
    let mut value = base.clone();
    value.version = "01.0.0".into();
    cases.push(value);
    let mut value = base.clone();
    value.license = "not a license ???".into();
    cases.push(value);
    let mut value = base.clone();
    value.junban_compatibility = "  ^0.1".into();
    cases.push(value);
    let mut value = base.clone();
    value.wit.version = "0.2.0".into();
    cases.push(value);
    for value in cases {
        assert!(value.validate().is_err());
    }
}

#[test]
fn manifest_enforces_permission_scopes_origins_and_declaration_grants() {
    let component = valid_component();
    let mut manifest = valid_manifest(&component);
    manifest.permissions = vec![Permission {
        capability: Capability::Http,
        scope: PermissionScope::Http(HttpScope {
            origins: vec![HttpOrigin("https://api.example.com".into())],
            methods: vec![HttpMethod::Get],
        }),
    }];
    assert!(manifest.validate().is_ok());
    for origin in [
        "http://api.example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://api.example.com/",
        "https://API.example.com",
        "https://api.example.com:443",
        "https://user@api.example.com",
    ] {
        let mut bad = manifest.clone();
        let PermissionScope::Http(scope) = &mut bad.permissions[0].scope else {
            unreachable!()
        };
        scope.origins[0] = HttpOrigin(origin.into());
        assert!(bad.validate().is_err(), "accepted {origin}");
    }
    let mut command = valid_manifest(&component);
    command.commands.push(CommandDeclaration {
        id: "run".into(),
        title: "Run".into(),
        description: String::new(),
        icon: None,
        inputs: Vec::new(),
    });
    assert!(command.validate().is_err());
    command.permissions.push(Permission {
        capability: Capability::Commands,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    });
    assert!(command.validate().is_ok());

    let mut events = valid_manifest(&component);
    events.permissions.push(Permission {
        capability: Capability::EventsSubscribe,
        scope: PermissionScope::Events(EventScope {
            event_kinds: vec![EventKind::TaskCreated],
        }),
    });
    assert!(events.validate().is_err());
    events.subscriptions.push(EventKind::TaskCreated);
    assert!(events.validate().is_ok());
    events.subscriptions.clear();
    assert!(events.validate().is_err());

    let service_scope = ServiceConsumeScope {
        services: vec![ServiceReference {
            plugin_id: "provider".into(),
            service_id: "lookup".into(),
        }],
    };
    let mut consume = valid_manifest(&component);
    consume.permissions.push(Permission {
        capability: Capability::ServicesConsume,
        scope: PermissionScope::Services(service_scope),
    });
    assert!(consume.validate().is_err());
    consume.dependencies.push(Dependency {
        id: "provider".into(),
        requirement: "^1".into(),
        services: vec!["lookup".into()],
    });
    assert!(consume.validate().is_ok());
    consume.dependencies[0].services.clear();
    assert!(consume.validate().is_err());
}

#[test]
fn manifest_rejects_duplicate_sort_bounds_dependencies_surfaces_settings_and_services() {
    let component = valid_component();
    let base = valid_manifest(&component);
    let mut duplicate = base.clone();
    duplicate.dependencies = vec![
        Dependency {
            id: "dep".into(),
            requirement: "^1".into(),
            services: vec![],
        },
        Dependency {
            id: "dep".into(),
            requirement: "^2".into(),
            services: vec![],
        },
    ];
    assert!(duplicate.validate().is_err());
    let mut self_dep = base.clone();
    self_dep.dependencies.push(Dependency {
        id: base.id.clone(),
        requirement: "^1".into(),
        services: vec![],
    });
    assert!(self_dep.validate().is_err());
    let mut surface = base.clone();
    surface.surfaces.push(SurfaceDeclaration {
        id: "panel".into(),
        kind: SurfaceKind::Panel,
        title: "Panel".into(),
        icon: None,
        location: SurfaceLocation::Navigation,
        actions: vec![],
    });
    surface.permissions.push(Permission {
        capability: Capability::UiPanel,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    });
    assert!(surface.validate().is_err());
    let mut overflow_setting = base.clone();
    overflow_setting.settings.push(SettingDeclaration {
        id: "integer".into(),
        label: "Integer".into(),
        description: String::new(),
        schema: SettingSchema::Integer {
            default: i64::MAX,
            min: i64::MIN,
            max: i64::MAX,
            step: 1,
        },
    });
    overflow_setting.permissions.push(Permission {
        capability: Capability::Settings,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    });
    assert!(overflow_setting.validate().is_err());
    let mut setting = base.clone();
    setting.settings.push(SettingDeclaration {
        id: "secret".into(),
        label: "Secret".into(),
        description: String::new(),
        schema: SettingSchema::Text {
            default: String::new(),
            min_bytes: 0,
            max_bytes: 8,
            secret: true,
        },
    });
    setting.permissions.push(Permission {
        capability: Capability::Settings,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    });
    assert!(setting.validate().is_err());
    let mut service = base.clone();
    service.services.push(ServiceDeclaration {
        id: "lookup".into(),
        title: "Lookup".into(),
        request: vec![
            ServiceField {
                id: "z".into(),
                kind: DataKind::String,
                required: true,
            },
            ServiceField {
                id: "a".into(),
                kind: DataKind::String,
                required: true,
            },
        ],
        response: vec![],
    });
    service.permissions.push(Permission {
        capability: Capability::ServicesProvide,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    });
    assert!(service.validate().is_err());
}

#[test]
fn permission_hash_framing_has_frozen_goldens_and_detects_ambiguity_reorder_change() {
    let unscoped = Permission {
        capability: Capability::Commands,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    };
    let http = Permission {
        capability: Capability::Http,
        scope: PermissionScope::Http(HttpScope {
            origins: vec![HttpOrigin("https://api.example.com".into())],
            methods: vec![HttpMethod::Get, HttpMethod::Post],
        }),
    };
    assert_eq!(
        hex(&scope_hash(&unscoped).unwrap()),
        "878d9a85309626bdfb41600b077b732d7cb0c606c4e0423cb183aa4a43c08bc6"
    );
    let sorted = vec![unscoped.clone(), http.clone()];
    assert_eq!(
        hex(&permission_set_hash(&sorted).unwrap()),
        "c7f3e2c8e817b1bf6fc2825f3a4abab8f4e40f62c5245284a84b8d4eb611c2ad"
    );
    assert!(permission_set_hash(&[http.clone(), unscoped.clone()]).is_err());
    assert!(permission_set_hash(&[unscoped.clone(), unscoped.clone()]).is_err());
    assert!(permission_set_hash(&vec![unscoped; PERMISSIONS_MAX + 1]).is_err());
    let mut changed = http;
    let PermissionScope::Http(scope) = &mut changed.scope else {
        unreachable!()
    };
    scope.methods.pop();
    assert_ne!(
        scope_hash(&changed).unwrap(),
        scope_hash(&sorted[1]).unwrap()
    );
    let subset = validate_permission_grants(&sorted, &[sorted[1].clone()]).unwrap();
    assert_eq!(subset.requested_hash, permission_set_hash(&sorted).unwrap());
    assert_eq!(
        subset.granted_hash,
        permission_set_hash(&[sorted[1].clone()]).unwrap()
    );
    assert!(validate_permission_grants(&sorted, &[]).is_ok());
    assert!(validate_permission_grants(&sorted, &[changed]).is_err());
    assert!(
        validate_permission_grants(
            &sorted,
            &[Permission {
                capability: Capability::TasksRead,
                scope: PermissionScope::Unscoped(UnscopedPermission {}),
            }]
        )
        .is_err()
    );
}

#[test]
fn graph_rejects_missing_incompatible_self_cycle_depth_fanout_and_validates_locks() {
    fn node(id: &str, version: &str, deps: Vec<Dependency>) -> RuntimeManifest {
        let component = valid_component();
        let mut manifest = valid_manifest(&component);
        manifest.id = id.into();
        manifest.version = version.into();
        let consumed_services: Vec<ServiceReference> = deps
            .iter()
            .flat_map(|dependency| {
                dependency
                    .services
                    .iter()
                    .map(|service_id| ServiceReference {
                        plugin_id: dependency.id.clone(),
                        service_id: service_id.clone(),
                    })
            })
            .collect();
        manifest.dependencies = deps;
        if !consumed_services.is_empty() {
            manifest.permissions.push(Permission {
                capability: Capability::ServicesConsume,
                scope: PermissionScope::Services(ServiceConsumeScope {
                    services: consumed_services,
                }),
            });
        }
        manifest
    }
    let root = node(
        "root",
        "1.0.0",
        vec![Dependency {
            id: "dep".into(),
            requirement: "^1".into(),
            services: vec![],
        }],
    );
    let dep = node("dep", "1.2.0", vec![]);
    let packages = [
        InstalledPackage {
            manifest: &root,
            package_generation: 2,
            package_sha256: &"1".repeat(64),
        },
        InstalledPackage {
            manifest: &dep,
            package_generation: 1,
            package_sha256: &"2".repeat(64),
        },
    ];
    assert_eq!(
        validate_dependency_graph(&packages)
            .unwrap()
            .activation_order,
        ["dep", "root"]
    );
    assert!(matches!(
        validate_dependency_graph(&packages[..1]),
        Err(GraphError::UnresolvedDependencies {
            missing,
            incompatible
        }) if missing.len() == 1 && incompatible.is_empty()
    ));
    let bad_dep = node("dep", "2.0.0", vec![]);
    let incompatible = [
        InstalledPackage {
            manifest: &root,
            package_generation: 2,
            package_sha256: &"1".repeat(64),
        },
        InstalledPackage {
            manifest: &bad_dep,
            package_generation: 1,
            package_sha256: &"2".repeat(64),
        },
    ];
    assert!(matches!(
        validate_dependency_graph(&incompatible),
        Err(GraphError::UnresolvedDependencies {
            missing,
            incompatible
        }) if missing.is_empty() && incompatible.len() == 1
    ));
    let mixed_root = node(
        "mixed-root",
        "1.0.0",
        vec![
            Dependency {
                id: "dep".into(),
                requirement: "^2".into(),
                services: vec![],
            },
            Dependency {
                id: "missing".into(),
                requirement: "^1".into(),
                services: vec![],
            },
        ],
    );
    let mixed = [
        InstalledPackage {
            manifest: &mixed_root,
            package_generation: 1,
            package_sha256: &"3".repeat(64),
        },
        InstalledPackage {
            manifest: &dep,
            package_generation: 1,
            package_sha256: &"2".repeat(64),
        },
    ];
    assert!(matches!(
        validate_dependency_graph(&mixed),
        Err(GraphError::UnresolvedDependencies {
            missing,
            incompatible
        }) if missing.len() == 1 && incompatible.len() == 1
    ));
    let invalid_authority = [InstalledPackage {
        manifest: &dep,
        package_generation: 0,
        package_sha256: &"2".repeat(64),
    }];
    assert_eq!(
        validate_dependency_graph(&invalid_authority),
        Err(GraphError::InvalidPackageAuthority)
    );
    let a = node(
        "a",
        "1.0.0",
        vec![Dependency {
            id: "b".into(),
            requirement: "^1".into(),
            services: vec![],
        }],
    );
    let b = node(
        "b",
        "1.0.0",
        vec![Dependency {
            id: "a".into(),
            requirement: "^1".into(),
            services: vec![],
        }],
    );
    let cycle = [
        InstalledPackage {
            manifest: &a,
            package_generation: 1,
            package_sha256: &"a".repeat(64),
        },
        InstalledPackage {
            manifest: &b,
            package_generation: 2,
            package_sha256: &"b".repeat(64),
        },
    ];
    assert!(matches!(
        validate_dependency_graph(&cycle),
        Err(GraphError::Cycle)
    ));
    let self_node = node(
        "self-node",
        "1.0.0",
        vec![Dependency {
            id: "self-node".into(),
            requirement: "^1".into(),
            services: vec![],
        }],
    );
    assert_eq!(
        validate_dependency_graph(&[InstalledPackage {
            manifest: &self_node,
            package_generation: 1,
            package_sha256: &"a".repeat(64),
        }]),
        Err(GraphError::SelfDependency)
    );
    let duplicate_node = node(
        "duplicate-node",
        "1.0.0",
        vec![
            Dependency {
                id: "dep".into(),
                requirement: "^1".into(),
                services: vec![],
            },
            Dependency {
                id: "dep".into(),
                requirement: "^1".into(),
                services: vec![],
            },
        ],
    );
    let duplicate_packages = [
        InstalledPackage {
            manifest: &duplicate_node,
            package_generation: 2,
            package_sha256: &"1".repeat(64),
        },
        InstalledPackage {
            manifest: &dep,
            package_generation: 1,
            package_sha256: &"2".repeat(64),
        },
    ];
    assert_eq!(
        validate_dependency_graph(&duplicate_packages),
        Err(GraphError::DuplicateDependency)
    );
    let service_node = node(
        "service-node",
        "1.0.0",
        vec![Dependency {
            id: "dep".into(),
            requirement: "^1".into(),
            services: vec!["missing-service".into()],
        }],
    );
    assert_eq!(
        validate_dependency_graph(&[
            InstalledPackage {
                manifest: &service_node,
                package_generation: 2,
                package_sha256: &"1".repeat(64),
            },
            InstalledPackage {
                manifest: &dep,
                package_generation: 1,
                package_sha256: &"2".repeat(64),
            },
        ]),
        Err(GraphError::MissingService)
    );

    let lock = DependencyLock {
        plugin_id: "root".into(),
        dependency_id: "dep".into(),
        version_requirement: "^1".into(),
        resolved_version: "1.2.0".into(),
        dependency_package_generation: 1,
        dependency_package_sha256: "2".repeat(64),
    };
    assert!(validate_dependency_locks(&packages, std::slice::from_ref(&lock)).is_ok());
    let mut bad_lock = lock;
    bad_lock.dependency_package_generation = 9;
    assert_eq!(
        validate_dependency_locks(&packages, &[bad_lock]),
        Err(GraphError::LockMismatch)
    );

    let mut chain = Vec::new();
    for index in 0..17 {
        chain.push(node(
            &format!("n{index}"),
            "1.0.0",
            if index == 0 {
                vec![]
            } else {
                vec![Dependency {
                    id: format!("n{}", index - 1),
                    requirement: "^1".into(),
                    services: vec![],
                }]
            },
        ));
    }
    let installed: Vec<_> = chain
        .iter()
        .enumerate()
        .map(|(index, manifest)| InstalledPackage {
            manifest,
            package_generation: index as u64 + 1,
            package_sha256: "a".repeat(64).leak(),
        })
        .collect();
    assert!(matches!(
        validate_dependency_graph(&installed),
        Err(GraphError::Depth)
    ));
    let mut fanout = node("fanout", "1.0.0", vec![]);
    fanout.dependencies = (0..17)
        .map(|index| Dependency {
            id: format!("d{index}"),
            requirement: "^1".into(),
            services: vec![],
        })
        .collect();
    assert!(matches!(
        validate_dependency_graph(&[InstalledPackage {
            manifest: &fanout,
            package_generation: 1,
            package_sha256: &"a".repeat(64)
        }]),
        Err(GraphError::Fanout)
    ));
}

#[test]
fn component_rejects_core_malformed_export_signature_profile_undeclared_and_metadata() {
    let core = b"\0asm\x01\0\0\0";
    let component = valid_component();
    let manifest = consumer_manifest(&component, RuntimeProfile::Rust);
    assert!(matches!(
        inspect_component(core, &manifest),
        Err(SdkError::ComponentEncoding)
    ));
    assert!(inspect_component(b"bad wasm", &manifest).is_err());
    assert!(matches!(
        inspect_component_reader(&mut Cursor::new(core), core.len() as u64, &manifest),
        Err(SdkError::ComponentEncoding)
    ));
    assert!(
        inspect_component_reader(
            &mut Cursor::new(b"bad wasm"),
            b"bad wasm".len() as u64,
            &manifest,
        )
        .is_err()
    );
    let nested = nested_component(COMPONENT_NESTING_MAX + 1);
    assert!(matches!(
        inspect_component(&nested, &valid_manifest(&nested)),
        Err(SdkError::ComponentAuthority {
            field: "component nesting"
        })
    ));
    let many_sections = component_with_custom_sections(COMPONENT_SECTIONS_MAX);
    assert!(matches!(
        inspect_component(&many_sections, &valid_manifest(&many_sections)),
        Err(SdkError::ComponentAuthority {
            field: "component sections"
        })
    ));

    let mut alternate_export = component.clone();
    replace_all_equal(
        &mut alternate_export,
        b"junban:plugin/guest@0.1.0",
        b"junban:plugin/guest@0.2.0",
    );
    let alternate_manifest = consumer_manifest(&alternate_export, RuntimeProfile::Rust);
    assert!(matches!(
        inspect_component(&alternate_export, &alternate_manifest),
        Err(SdkError::ComponentAuthority { field: "exports" })
    ));

    let mut mismatched = component.clone();
    replace_all_equal(&mut mismatched, b"activate", b"bctivate");
    let mismatch_manifest = consumer_manifest(&mismatched, RuntimeProfile::Rust);
    assert!(matches!(
        inspect_component(&mismatched, &mismatch_manifest),
        Err(SdkError::ComponentAuthority { field: "guest ABI" })
    ));

    let imported = component.clone();
    let mut wrong_import_abi = imported.clone();
    replace_all_equal(&mut wrong_import_abi, b"query-tasks", b"query-fasks");
    assert!(matches!(
        inspect_component(
            &wrong_import_abi,
            &consumer_manifest(&wrong_import_abi, RuntimeProfile::Rust),
        ),
        Err(SdkError::ComponentAuthority {
            field: "import ABI"
        })
    ));
    let mut unknown_import = imported.clone();
    replace_all_equal(
        &mut unknown_import,
        b"junban:plugin/host-tasks@0.1.0",
        b"evilxx:plugin/host-tasks@0.1.0",
    );
    let unknown_manifest = consumer_manifest(&unknown_import, RuntimeProfile::Rust);
    assert!(matches!(
        inspect_component(&unknown_import, &unknown_manifest),
        Err(SdkError::ComponentAuthority {
            field: "unknown import"
        })
    ));
    let mut no_grant = valid_manifest(&imported);
    no_grant
        .permissions
        .retain(|permission| permission.capability != Capability::TasksRead);
    assert!(matches!(
        inspect_component(&imported, &no_grant),
        Err(SdkError::ComponentAuthority {
            field: "undeclared import"
        })
    ));
    let granted = consumer_manifest(&imported, RuntimeProfile::Rust);
    assert!(inspect_component(&imported, &granted).is_ok());

    let wrong_profile = consumer_manifest(&component, RuntimeProfile::Typescript);
    assert!(matches!(
        inspect_component(&component, &wrong_profile),
        Err(SdkError::ComponentAuthority {
            field: "runtime profile imports"
        })
    ));
    let rust_component = component.clone();
    let mut rust_profile = consumer_manifest(&rust_component, RuntimeProfile::Rust);
    let rust_inspection = inspect_component(&rust_component, &rust_profile).unwrap();
    assert_eq!(
        rust_inspection
            .imports
            .iter()
            .filter(|import| import.starts_with("wasi:"))
            .map(String::as_str)
            .collect::<Vec<_>>(),
        RUST_WASI_BASELINE
    );
    assert_eq!(
        hex(&sha256(&rust_component)),
        "0bd13500bddde8baecd79a974a3f32951c13b187b2e22eeb07ae8b51a536d0e1"
    );
    let mut wrong_wasi_abi = rust_component.clone();
    replace_all_equal(&mut wrong_wasi_abi, b"exit", b"exix");
    replace_all_equal(&mut wrong_wasi_abi, b"wasi:cli/exix", b"wasi:cli/exit");
    rust_profile.component_sha256 = hex(&sha256(&wrong_wasi_abi));
    assert!(matches!(
        inspect_component(&wrong_wasi_abi, &rust_profile),
        Err(SdkError::ComponentAuthority {
            field: "import ABI"
        })
    ));

    let mut oversized = component.clone();
    append_name_section(&mut oversized, COMPONENT_AUTHORITY_METADATA_SECTION_MAX + 1);
    assert!(inspect_component(&oversized, &valid_manifest(&oversized)).is_err());
    let mut oversized_producers = component.clone();
    append_custom_section(
        &mut oversized_producers,
        "producers",
        COMPONENT_AUTHORITY_METADATA_SECTION_MAX + 1,
    );
    assert!(
        inspect_component(&oversized_producers, &valid_manifest(&oversized_producers)).is_err()
    );
    let mut oversized_unknown = component.clone();
    append_custom_section(
        &mut oversized_unknown,
        "unknown-metadata",
        COMPONENT_AUTHORITY_METADATA_SECTION_MAX + 1,
    );
    assert!(matches!(
        inspect_component(&oversized_unknown, &valid_manifest(&oversized_unknown)),
        Err(SdkError::ComponentAuthority {
            field: "metadata section"
        })
    ));
    let mut aggregate_oversized = component.clone();
    append_name_section(
        &mut aggregate_oversized,
        COMPONENT_AUTHORITY_METADATA_SECTION_MAX,
    );
    append_name_section(
        &mut aggregate_oversized,
        COMPONENT_AUTHORITY_METADATA_SECTION_MAX,
    );
    append_name_section(&mut aggregate_oversized, 1);
    assert!(
        inspect_component(&aggregate_oversized, &valid_manifest(&aggregate_oversized)).is_err()
    );
}

#[test]
fn jri1_strict_verification_and_package_agreement() {
    let package_bytes = valid_package();
    let package = verify_package(&package_bytes).unwrap();
    let key = root_key();
    let mut index = RegistryIndex {
        schema_version: 1,
        junban_version: "0.1.0".into(),
        generated_at: "2026-08-04T00:00:00Z".into(),
        root_key_id: hex(&sha256(&key.verifying_key().to_bytes())),
        entries: vec![valid_registry_entry(&package)],
    };
    let envelope = registry_envelope(&index, &key);
    let verified = parse_and_verify_registry(&envelope, &key.verifying_key().to_bytes()).unwrap();
    validate_registry_package_agreement(&verified.index.entries[0], &package).unwrap();
    assert!(parse_and_verify_registry(&envelope, &test_key().verifying_key().to_bytes()).is_err());
    let mut magic = envelope.clone();
    magic[0] ^= 1;
    assert!(matches!(
        parse_and_verify_registry(&magic, &key.verifying_key().to_bytes()),
        Err(SdkError::Magic { .. })
    ));
    let mut trailing = envelope.clone();
    trailing.push(0);
    assert!(matches!(
        parse_and_verify_registry(&trailing, &key.verifying_key().to_bytes()),
        Err(SdkError::Trailing { .. })
    ));
    assert!(
        parse_and_verify_registry(
            &envelope[..envelope.len() - 1],
            &key.verifying_key().to_bytes()
        )
        .is_err()
    );
    let mut signature = envelope.clone();
    *signature.last_mut().unwrap() ^= 1;
    assert!(matches!(
        parse_and_verify_registry(&signature, &key.verifying_key().to_bytes()),
        Err(SdkError::Signature)
    ));
    let index_length = u32::from_be_bytes(envelope[8..12].try_into().unwrap()) as usize;
    let mut wrong_domain = envelope.clone();
    let wrong = key.sign(b"junban.plugin.registry.v0\0").to_bytes();
    wrong_domain[12 + index_length..].copy_from_slice(&wrong);
    assert!(matches!(
        parse_and_verify_registry(&wrong_domain, &key.verifying_key().to_bytes()),
        Err(SdkError::Signature)
    ));
    index.entries[0].filename = "../escape.jbp".into();
    assert!(
        parse_and_verify_registry(
            &registry_envelope(&index, &key),
            &key.verifying_key().to_bytes()
        )
        .is_err()
    );

    let agreement = valid_registry_entry(&package);
    let mut disagreements = Vec::new();
    let mut changed = agreement.clone();
    changed.plugin_id = "another-plugin".into();
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.version = "2.0.0".into();
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.package_size += 1;
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.package_sha256 = "0".repeat(64);
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.publisher_key_id = "0".repeat(64);
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.name = "Another Name".into();
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.description = "Another description".into();
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.author = "Another Publisher".into();
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.license = "Apache-2.0".into();
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.runtime_profile = RuntimeProfile::Typescript;
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.requested_capabilities.push(Capability::TasksRead);
    disagreements.push(changed);
    let mut changed = agreement.clone();
    changed.filename = format!("plugins/{}/other.jbp", &agreement.package_sha256[..2]);
    disagreements.push(changed);
    for disagreement in disagreements {
        assert!(validate_registry_package_agreement(&disagreement, &package).is_err());
    }
}

#[test]
fn jri1_rejects_unknown_duplicate_float_whitespace_root_and_entry_bounds() {
    let key = root_key();
    let index = RegistryIndex {
        schema_version: 1,
        junban_version: "0.1.0".into(),
        generated_at: "2026-08-04T00:00:00Z".into(),
        root_key_id: hex(&sha256(&key.verifying_key().to_bytes())),
        entries: vec![],
    };
    let canonical = serde_json::to_string(&index).unwrap();
    for bad in [
        canonical.replacen("{", "{\"unknown\":1,", 1),
        canonical.replacen(
            "\"schema_version\":1",
            "\"schema_version\":1,\"schema_version\":1",
            1,
        ),
        canonical.replacen("\"schema_version\":1", "\"schema_version\":1.0", 1),
        format!(" {canonical}"),
    ] {
        let bytes = bad.as_bytes();
        let mut envelope = JRI1_MAGIC.to_vec();
        envelope.extend_from_slice(&u32::try_from(bytes.len()).unwrap().to_be_bytes());
        envelope.extend_from_slice(bytes);
        envelope.extend_from_slice(&[0; 64]);
        assert!(parse_and_verify_registry(&envelope, &key.verifying_key().to_bytes()).is_err());
    }
    let mut zero_length = JRI1_MAGIC.to_vec();
    zero_length.extend_from_slice(&0_u32.to_be_bytes());
    zero_length.extend_from_slice(&[0; 64]);
    assert!(parse_and_verify_registry(&zero_length, &key.verifying_key().to_bytes()).is_err());
    let mut huge_length = JRI1_MAGIC.to_vec();
    huge_length.extend_from_slice(
        &u32::try_from(REGISTRY_INDEX_BYTES_MAX + 1)
            .unwrap()
            .to_be_bytes(),
    );
    huge_length.extend_from_slice(&[0; 64]);
    assert!(parse_and_verify_registry(&huge_length, &key.verifying_key().to_bytes()).is_err());
    let component = valid_component();
    let mut capability_manifest = valid_manifest(&component);
    capability_manifest.permissions = vec![
        Permission {
            capability: Capability::Commands,
            scope: PermissionScope::Unscoped(UnscopedPermission {}),
        },
        Permission {
            capability: Capability::TasksRead,
            scope: PermissionScope::Unscoped(UnscopedPermission {}),
        },
    ];
    let package_bytes = pack_package(&capability_manifest, &component, &test_key()).unwrap();
    let package = verify_package(&package_bytes).unwrap();
    let capability_index = RegistryIndex {
        schema_version: 1,
        junban_version: "0.1.0".into(),
        generated_at: "2026-08-04T00:00:00Z".into(),
        root_key_id: hex(&sha256(&key.verifying_key().to_bytes())),
        entries: vec![valid_registry_entry(&package)],
    };
    assert!(
        parse_and_verify_registry(
            &registry_envelope(&capability_index, &key),
            &key.verifying_key().to_bytes()
        )
        .is_ok()
    );
    let mut reversed_capabilities = capability_index;
    reversed_capabilities.entries[0]
        .requested_capabilities
        .reverse();
    assert!(
        parse_and_verify_registry(
            &registry_envelope(&reversed_capabilities, &key),
            &key.verifying_key().to_bytes()
        )
        .is_err()
    );

    let mut wrong_root = index;
    wrong_root.root_key_id = "0".repeat(64);
    assert!(matches!(
        parse_and_verify_registry(
            &registry_envelope(&wrong_root, &key),
            &key.verifying_key().to_bytes()
        ),
        Err(SdkError::Registry {
            field: "root_key_id"
        })
    ));
}

#[test]
fn protocol_frames_are_canonical_bounded_and_identity_fenced() {
    let fence = AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 1,
        activation_epoch: 2,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
        invocation_id: "00000000-0000-4000-8000-000000000002".into(),
    };
    assert!(fence.validate().is_ok());
    let frame = ParentFrame::Cancel {
        fence: fence.clone(),
    };
    let encoded = encode_parent_frame(&frame).unwrap();
    assert_eq!(decode_parent_frame(&encoded).unwrap(), frame);
    validate_parent_frame(&frame).unwrap();
    let mut stale = fence.clone();
    stale.activation_epoch += 1;
    assert!(!fence.exact_matches(&stale));
    let mut invalid = fence;
    invalid.package_generation = 0;
    assert!(invalid.validate().is_err());
    assert!(decode_parent_frame(&encoded[..encoded.len() - 1]).is_err());
    let mut trailing = encoded;
    trailing.push(0);
    assert!(decode_parent_frame(&trailing).is_err());
    let unknown_payload = br#"{"type":"shutdown","host_session_id":"00000000-0000-4000-8000-000000000001","token":"forbidden"}"#;
    let mut unknown_frame = Vec::new();
    unknown_frame.extend_from_slice(&u32::try_from(unknown_payload.len()).unwrap().to_be_bytes());
    unknown_frame.extend_from_slice(unknown_payload);
    assert!(decode_parent_frame(&unknown_frame).is_err());
    let invalid = ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION + 1,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
    };
    assert!(encode_parent_frame(&invalid).is_err());
    let invalid_payload = serde_json::to_vec(&invalid).unwrap();
    let mut invalid_frame = Vec::new();
    invalid_frame.extend_from_slice(&u32::try_from(invalid_payload.len()).unwrap().to_be_bytes());
    invalid_frame.extend_from_slice(&invalid_payload);
    assert!(decode_parent_frame(&invalid_frame).is_err());
    let wrong_protocol = ParentFrame::Hello {
        protocol_name: "not-junban".into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
    };
    assert!(encode_parent_frame(&wrong_protocol).is_err());
    let mut oversized_header = Vec::new();
    oversized_header.extend_from_slice(
        &u32::try_from(HOST_FRAME_BYTES_MAX + 1)
            .unwrap()
            .to_be_bytes(),
    );
    assert!(decode_parent_frame(&oversized_header).is_err());
    let oversized = ParentFrame::Shutdown {
        host_session_id: "x".repeat(HOST_FRAME_BYTES_MAX),
    };
    assert!(encode_parent_frame(&oversized).is_err());
    let failure_fence = AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 1,
        activation_epoch: 2,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
        invocation_id: "00000000-0000-4000-8000-000000000002".into(),
    };
    let child = ChildFrame::Failed {
        fence: failure_fence.clone(),
        code: HostFailureCode::Unavailable,
    };
    let encoded_child = encode_child_frame(&child).unwrap();
    assert_eq!(decode_child_frame(&encoded_child).unwrap(), child);
    validate_failed_correlation(&child, &failure_fence).unwrap();
    let mut stale_failure = child;
    if let ChildFrame::Failed { fence, .. } = &mut stale_failure {
        fence.activation_epoch += 1;
    }
    assert!(validate_failed_correlation(&stale_failure, &failure_fence).is_err());
    assert!(
        validate_failed_correlation(
            &ChildFrame::ShutdownComplete {
                host_session_id: failure_fence.host_session_id.clone(),
            },
            &failure_fence
        )
        .is_err()
    );
}

#[test]
fn protocol_raw_bodies_are_exact_bounded_and_hash_verified() {
    let fence = AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 1,
        activation_epoch: 2,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
        invocation_id: "00000000-0000-4000-8000-000000000002".into(),
    };

    let component = b"component bytes";
    let load = ParentFrame::Load {
        fence: fence.clone(),
        package_sha256: "1".repeat(64),
        component_sha256: hex(&sha256(component)),
        import_export_fingerprint: "3".repeat(64),
        runtime_profile: RuntimeProfile::Typescript,
        component_size: u64::try_from(component.len()).unwrap(),
        grants: Vec::new(),
        permission_hash: canonical_permission_hash(&[]).unwrap(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
    };
    assert_eq!(parent_body_len(&load).unwrap(), component.len());
    validate_parent_body(&load, component).unwrap();

    let request_message = InvocationRequest::activate(None)
        .into_parent_message(fence.clone(), canonical_permission_hash(&[]).unwrap())
        .unwrap();
    let (invoke, request) = request_message.into_parts();
    assert_eq!(parent_body_len(&invoke).unwrap(), request.len());
    validate_parent_body(&invoke, &request).unwrap();

    let outcome_message = InvocationOutcome::Activate(private_body_types::WitResult::Ok(()))
        .into_child_message(fence.clone())
        .unwrap();
    let (outcome_frame, outcome) = outcome_message.into_parts();
    assert_eq!(child_body_len(&outcome_frame).unwrap(), outcome.len());
    validate_child_body(&outcome_frame, &outcome).unwrap();

    let mut wrong_hash = invoke.clone();
    if let ParentFrame::Invoke { request_sha256, .. } = &mut wrong_hash {
        *request_sha256 = "0".repeat(64);
    }
    assert!(validate_parent_body(&wrong_hash, &request).is_err());
    assert!(validate_parent_body(&invoke, &request[..request.len() - 1]).is_err());
    assert!(validate_parent_body(&invoke, b"").is_err());
    let mut trailing = request.clone();
    trailing.push(0);
    assert!(validate_parent_body(&invoke, &trailing).is_err());

    let no_body = ParentFrame::Cancel {
        fence: fence.clone(),
    };
    assert_eq!(parent_body_len(&no_body).unwrap(), 0);
    validate_parent_body(&no_body, b"").unwrap();
    assert!(validate_parent_body(&no_body, b"unexpected").is_err());

    let oversized_component = ParentFrame::Load {
        fence: fence.clone(),
        package_sha256: "1".repeat(64),
        component_sha256: "2".repeat(64),
        import_export_fingerprint: "3".repeat(64),
        runtime_profile: RuntimeProfile::Typescript,
        component_size: u64::try_from(HOST_COMPONENT_BODY_BYTES_MAX + 1).unwrap(),
        grants: Vec::new(),
        permission_hash: canonical_permission_hash(&[]).unwrap(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
    };
    assert!(validate_parent_body(&oversized_component, b"").is_err());
    let oversized_request = ParentFrame::Invoke {
        fence: fence.clone(),
        kind: InvocationKind::InvokeCommand,
        mode: InvocationMode::Effect,
        permission_hash: canonical_permission_hash(&[]).unwrap(),
        request_sha256: "2".repeat(64),
        request_size: u32::try_from(HOST_REQUEST_BODY_BYTES_MAX + 1).unwrap(),
    };
    assert!(validate_parent_body(&oversized_request, b"").is_err());
    let oversized_outcome = ChildFrame::Outcome {
        fence: fence.clone(),
        kind: InvocationKind::Activate,
        outcome_sha256: "2".repeat(64),
        outcome_size: u32::try_from(HOST_OUTCOME_BODY_BYTES_MAX + 1).unwrap(),
    };
    assert!(validate_child_body(&oversized_outcome, b"").is_err());
    let empty_outcome = ChildFrame::Outcome {
        fence,
        kind: InvocationKind::Activate,
        outcome_sha256: hex(&sha256(b"")),
        outcome_size: 0,
    };
    assert!(validate_child_body(&empty_outcome, b"").is_err());
}

#[test]
fn protocol_exhausts_invocation_modes_host_calls_and_grants() {
    let invocation_rows = [
        (InvocationKind::Activate, InvocationMode::Lifecycle),
        (InvocationKind::Deactivate, InvocationMode::Lifecycle),
        (InvocationKind::InvokeCommand, InvocationMode::Effect),
        (InvocationKind::HandleEvent, InvocationMode::Effect),
        (InvocationKind::RenderSurface, InvocationMode::Render),
        (InvocationKind::HandleSurfaceAction, InvocationMode::Effect),
        (
            InvocationKind::ValidateSettings,
            InvocationMode::ValidateSettings,
        ),
        (InvocationKind::Resync, InvocationMode::Resync),
        (InvocationKind::CallService, InvocationMode::Service),
    ];
    for (kind, expected) in invocation_rows {
        assert_eq!(kind.mode(), expected);
        for candidate in [
            InvocationMode::Lifecycle,
            InvocationMode::Effect,
            InvocationMode::Render,
            InvocationMode::ValidateSettings,
            InvocationMode::Resync,
            InvocationMode::Service,
        ] {
            assert_eq!(kind.mode() == candidate, expected == candidate);
        }
    }

    let modes = [
        InvocationMode::Lifecycle,
        InvocationMode::Effect,
        InvocationMode::Render,
        InvocationMode::ValidateSettings,
        InvocationMode::Resync,
        InvocationMode::Service,
    ];
    assert_eq!(HOST_CALL_KINDS.len(), 11);
    for kind in HOST_CALL_KINDS {
        let grants = kind.capability().map_or_else(Vec::new, |capability| {
            let scope = match capability {
                Capability::Http => PermissionScope::Http(HttpScope {
                    origins: vec![HttpOrigin("https://example.com".into())],
                    methods: vec![HttpMethod::Get],
                }),
                Capability::ServicesConsume => PermissionScope::Services(ServiceConsumeScope {
                    services: vec![ServiceReference {
                        plugin_id: "dependency".into(),
                        service_id: "service".into(),
                    }],
                }),
                _ => PermissionScope::Unscoped(UnscopedPermission {}),
            };
            vec![Permission { capability, scope }]
        });
        for mode in modes {
            assert_eq!(
                validate_host_call_authority(*kind, mode, &grants).is_ok(),
                kind.allowed_in(mode),
                "{kind:?}/{mode:?}"
            );
            if kind.capability().is_some() {
                assert!(validate_host_call_authority(*kind, mode, &[]).is_err());
            }
        }
    }
}

#[test]
fn protocol_callback_authority_binds_exact_load_activation_mode_and_grants() {
    let load_fence = AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
        invocation_id: "00000000-0000-4000-8000-000000000002".into(),
    };
    let grants = vec![Permission {
        capability: Capability::Logging,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    }];
    let permission_hash = canonical_permission_hash(&grants).unwrap();
    let load = ParentFrame::Load {
        fence: load_fence.clone(),
        package_sha256: "1".repeat(64),
        component_sha256: "2".repeat(64),
        import_export_fingerprint: "3".repeat(64),
        runtime_profile: RuntimeProfile::Rust,
        component_size: 1,
        grants,
        permission_hash: permission_hash.clone(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
    };
    let mut invoke_fence = load_fence;
    invoke_fence.invocation_id = "00000000-0000-4000-8000-000000000003".into();
    let invoke = ParentFrame::Invoke {
        fence: invoke_fence.clone(),
        kind: InvocationKind::Activate,
        mode: InvocationMode::Lifecycle,
        permission_hash,
        request_sha256: hex(&sha256(b"request")),
        request_size: 7,
    };
    let request = ChildFrame::CapabilityRequest {
        callback: CallbackFence {
            plugin_id: invoke_fence.plugin_id.clone(),
            package_generation: invoke_fence.package_generation,
            activation_epoch: invoke_fence.activation_epoch,
            host_session_id: invoke_fence.host_session_id.clone(),
            invocation_id: invoke_fence.invocation_id.clone(),
            callback_id: 1,
        },
        kind: HostCallKind::Log,
        request_sha256: hex(&sha256(b"log")),
        request_size: 3,
    };
    validate_capability_request_authority(&load, &invoke, &request).unwrap();

    let mut changed_hash = invoke.clone();
    if let ParentFrame::Invoke {
        permission_hash, ..
    } = &mut changed_hash
    {
        *permission_hash = "0".repeat(64);
    }
    assert!(validate_capability_request_authority(&load, &changed_hash, &request).is_err());

    let mut stale_request = request.clone();
    if let ChildFrame::CapabilityRequest { callback, .. } = &mut stale_request {
        callback.activation_epoch += 1;
    }
    assert!(validate_capability_request_authority(&load, &invoke, &stale_request).is_err());

    let mut ungranted = request.clone();
    if let ChildFrame::CapabilityRequest { kind, .. } = &mut ungranted {
        *kind = HostCallKind::GetKv;
    }
    assert!(validate_capability_request_authority(&load, &invoke, &ungranted).is_err());

    let mut denied_mode = request;
    if let ChildFrame::CapabilityRequest { kind, .. } = &mut denied_mode {
        *kind = HostCallKind::HttpRequest;
    }
    assert!(validate_capability_request_authority(&load, &invoke, &denied_mode).is_err());
}

#[test]
fn protocol_load_callback_cancellation_and_limits_are_fenced() {
    let rust_limits = RuntimeLimits::for_profile(RuntimeProfile::Rust);
    let typescript_limits = RuntimeLimits::for_profile(RuntimeProfile::Typescript);
    assert_eq!(rust_limits.fuel, RUST_INVOCATION_FUEL);
    assert_eq!(typescript_limits.fuel, TYPESCRIPT_INVOCATION_FUEL);
    assert_ne!(rust_limits.fuel, typescript_limits.fuel);
    assert_eq!(
        serde_json::to_string(&rust_limits).unwrap(),
        format!(
            "{{\"linear_memory_bytes\":67108864,\"guest_stack_bytes\":2097152,\"table_elements\":10000,\"memories\":1,\"tables\":2,\"instances\":14,\"fuel\":{},\"host_resources\":64,\"hostcall_copy_bytes\":4194304,\"output_bytes\":262144,\"guest_log_message_bytes\":4096,\"guest_log_fields\":16,\"guest_log_invocation_bytes\":32768,\"wasi_stderr_bytes\":32768,\"compile_timeout_ms\":10000,\"command_timeout_ms\":1000,\"event_render_timeout_ms\":250,\"http_timeout_ms\":5000}}",
            RUST_INVOCATION_FUEL
        )
    );
    for kind in [
        InvocationKind::Activate,
        InvocationKind::Deactivate,
        InvocationKind::InvokeCommand,
        InvocationKind::HandleSurfaceAction,
        InvocationKind::CallService,
    ] {
        assert_eq!(rust_limits.invocation_timeout_ms(kind), COMMAND_TIMEOUT_MS);
    }
    for kind in [
        InvocationKind::HandleEvent,
        InvocationKind::RenderSurface,
        InvocationKind::ValidateSettings,
        InvocationKind::Resync,
    ] {
        assert_eq!(
            rust_limits.invocation_timeout_ms(kind),
            EVENT_RENDER_TIMEOUT_MS
        );
    }

    let fence = AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
        invocation_id: "00000000-0000-4000-8000-000000000002".into(),
    };
    let grants = vec![Permission {
        capability: Capability::Logging,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    }];
    let permission_hash = canonical_permission_hash(&grants).unwrap();
    let component = b"component";
    let load = ParentFrame::Load {
        fence: fence.clone(),
        package_sha256: "1".repeat(64),
        component_sha256: hex(&sha256(component)),
        import_export_fingerprint: "3".repeat(64),
        runtime_profile: RuntimeProfile::Rust,
        component_size: component.len() as u64,
        grants: grants.clone(),
        permission_hash: permission_hash.clone(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
    };
    validate_parent_body(&load, component).unwrap();

    let mut wrong_fingerprint = load.clone();
    if let ParentFrame::Load {
        import_export_fingerprint,
        ..
    } = &mut wrong_fingerprint
    {
        *import_export_fingerprint = "not-a-hash".into();
    }
    assert!(validate_parent_frame(&wrong_fingerprint).is_err());
    let mut wrong_hash = load.clone();
    if let ParentFrame::Load {
        permission_hash, ..
    } = &mut wrong_hash
    {
        *permission_hash = "0".repeat(64);
    }
    assert!(validate_parent_frame(&wrong_hash).is_err());
    let mut wrong_limit = load.clone();
    if let ParentFrame::Load { limits, .. } = &mut wrong_limit {
        limits.output_bytes += 1;
    }
    assert!(validate_parent_frame(&wrong_limit).is_err());
    let mut wrong_profile_limit = load.clone();
    if let ParentFrame::Load {
        runtime_profile, ..
    } = &mut wrong_profile_limit
    {
        *runtime_profile = RuntimeProfile::Typescript;
    }
    assert!(validate_parent_frame(&wrong_profile_limit).is_err());

    let callback = CallbackFence {
        plugin_id: fence.plugin_id.clone(),
        package_generation: fence.package_generation,
        activation_epoch: fence.activation_epoch,
        host_session_id: fence.host_session_id.clone(),
        invocation_id: fence.invocation_id.clone(),
        callback_id: 1,
    };
    let large_bytes = vec![7; HOST_OUTCOME_BODY_BYTES_MAX + 1];
    let request_message = HostCallRequest::HttpRequest(private_body_types::HttpRequest {
        method: private_body_types::HttpMethod::Post,
        origin: "https://example.com".into(),
        path_and_query: "/callback".into(),
        headers: Vec::new(),
        body: private_body_types::ByteList::new(large_bytes.clone()).unwrap(),
    })
    .into_child_message(callback.clone())
    .unwrap();
    let (request, request_body) = request_message.into_parts();
    assert!(request_body.len() > HOST_OUTCOME_BODY_BYTES_MAX);
    validate_child_body(&request, &request_body).unwrap();
    validate_callback_correlation(&fence, 1, &callback).unwrap();

    let reply_message = HostCallReply::HttpRequest(private_body_types::WitResult::Ok(
        private_body_types::HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: private_body_types::ByteList::new(large_bytes).unwrap(),
            truncated: false,
        },
    ))
    .into_parent_message(callback.clone())
    .unwrap();
    let (reply, reply_body) = reply_message.into_parts();
    validate_parent_body(&reply, &reply_body).unwrap();
    validate_capability_reply(&request, &reply, &fence).unwrap();
    assert!(validate_parent_body(&reply, &reply_body[..reply_body.len() - 1]).is_err());
    let mut wrong_kind = reply.clone();
    if let ParentFrame::CapabilityReply { kind, .. } = &mut wrong_kind {
        *kind = HostCallKind::GetKv;
    }
    assert!(validate_capability_reply(&request, &wrong_kind, &fence).is_err());
    let mut stale = callback.clone();
    stale.activation_epoch += 1;
    assert!(validate_callback_correlation(&fence, 1, &stale).is_err());
    let mut mismatched = callback.clone();
    mismatched.callback_id += 1;
    assert!(validate_callback_correlation(&fence, 1, &mismatched).is_err());
    let mut over_id = callback.clone();
    over_id.callback_id = HOST_CALLBACK_ID_MAX + 1;
    assert!(over_id.validate().is_err());

    let over_limit = ChildFrame::CapabilityRequest {
        callback,
        kind: HostCallKind::GetKv,
        request_sha256: "2".repeat(64),
        request_size: HOST_CALLBACK_BODY_BYTES_MAX as u32 + 1,
    };
    assert!(validate_child_frame(&over_limit).is_err());

    let cancelled = ParentFrame::CapabilityReply {
        callback: stale,
        kind: HostCallKind::HttpRequest,
        result: CapabilityReplyKind::Cancelled,
        response_sha256: hex(&sha256(b"")),
        response_size: 0,
    };
    validate_parent_body(&cancelled, b"").unwrap();
    let cancel = ParentFrame::Cancel {
        fence: fence.clone(),
    };
    let cancelled_ack = ChildFrame::Cancelled { fence };
    assert_eq!(parent_body_len(&cancel).unwrap(), 0);
    assert_eq!(child_body_len(&cancelled_ack).unwrap(), 0);
}

#[test]
fn product_entrypoint_fingerprint_and_linkage_marker_are_stable() {
    let material = PRODUCT_ENTRYPOINTS.join("\n");
    assert_eq!(
        hex(&sha256(material.as_bytes())),
        PRODUCT_ENTRYPOINT_FINGERPRINT
    );
    assert!(
        std::str::from_utf8(product_linkage_marker())
            .unwrap()
            .starts_with("JUNBAN_PLUGIN_SDK_LINKAGE_V1:")
    );
    let authority = product_linkage_authority();
    assert_eq!(authority.entrypoints, &PRODUCT_ENTRYPOINTS);
    assert!(std::ptr::eq(
        authority.entrypoint_functions,
        &PRODUCT_ENTRYPOINT_FUNCTIONS
    ));
    let functions = authority.entrypoint_functions;
    assert!(std::ptr::fn_addr_eq(
        functions.inspect_and_verify_package,
        inspect_and_verify_package as ProductInspectEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.inspect_component,
        inspect_component as ProductInspectComponentEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.pack_package,
        pack_package as ProductPackPackageEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.parse_and_verify_registry,
        parse_and_verify_registry as ProductParseRegistryEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.permission_set_hash,
        permission_set_hash as ProductPermissionHashEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.validate_dependency_graph,
        validate_dependency_graph as ProductValidateGraphEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.validate_dependency_locks,
        validate_dependency_locks as ProductValidateLocksEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.validate_permission_grants,
        validate_permission_grants as ProductValidateGrantsEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.validate_registry_package_agreement,
        validate_registry_package_agreement as ProductValidateRegistryAgreementEntrypoint
    ));
    assert!(std::ptr::fn_addr_eq(
        functions.verify_signer_authority,
        verify_signer_authority as ProductVerifySignerEntrypoint
    ));
    assert_eq!(authority.fingerprint, PRODUCT_ENTRYPOINT_FINGERPRINT);
    assert_eq!(authority.marker, product_linkage_marker());
    assert!(authority.authority_type_sizes.iter().all(|size| *size > 0));
    assert_eq!(IMPORT_AUTHORITIES.len(), 10);
    assert_eq!(DECLARATION_AUTHORITIES.len(), 7);
    assert_eq!(OUTCOME_AUTHORITIES.len(), 15);
    assert_eq!(import_authority("unknown:plugin/import@0.1.0"), None);
    for authority in DECLARATION_AUTHORITIES {
        assert_eq!(declaration_authority(authority.kind), *authority);
    }
    for authority in OUTCOME_AUTHORITIES {
        assert_eq!(outcome_authority(authority.kind), *authority);
    }
}

proptest! {
    #[test]
    fn bounded_package_parser_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..8192)) {
        let _ = parse_package(&bytes);
        let _ = verify_package(&bytes);
    }

    #[test]
    fn bounded_registry_and_protocol_parsers_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..8192)) {
        let _ = parse_and_verify_registry(&bytes, &[0; 32]);
        let _ = decode_parent_frame(&bytes);
        let _ = decode_child_frame(&bytes);
    }
}

#[test]
fn plugin_identity_and_version_authorities_are_canonical() {
    let plugin_id = PluginId::parse("plugin-2").unwrap();
    assert_eq!(plugin_id.as_str(), "plugin-2");
    for invalid in ["", "Plugin", "plugin--two", "plugin-", "plugin_two"] {
        assert!(PluginId::parse(invalid).is_err(), "accepted {invalid:?}");
    }
    assert!(PluginId::parse("a".repeat(65)).is_err());

    let digest = Sha256Digest::of(b"authority");
    assert_eq!(digest.as_str().len(), 64);
    assert!(Sha256Digest::parse(digest.as_str().to_uppercase()).is_err());
    assert!(Sha256Digest::parse("0".repeat(63)).is_err());
    let public_key = test_key().verifying_key().to_bytes();
    assert_eq!(
        validate_signer_public_key(&public_key).unwrap(),
        signer_key_id(&public_key)
    );
    assert_eq!(
        serde_json::from_str::<Sha256Digest>(&format!("\"{digest}\"")).unwrap(),
        digest
    );

    assert_eq!(
        compare_versions("1.2.3", "1.3.0").unwrap(),
        std::cmp::Ordering::Less
    );
    assert!(compare_versions("1.2", "1.3.0").is_err());
    assert!(version_matches("^1.2", "1.9.0").unwrap());
    assert!(!version_matches("^1.2", "2.0.0").unwrap());
}

#[test]
fn persisted_setting_validation_rejects_secrets_types_controls_and_bad_steps() {
    let visible = SettingSchema::Text {
        default: String::new(),
        min_bytes: 1,
        max_bytes: 8,
        secret: false,
    };
    assert!(
        visible
            .validate_persisted_value(&SettingValue::Text("value".into()))
            .is_ok()
    );
    assert!(
        visible
            .validate_persisted_value(&SettingValue::Text("bad\0".into()))
            .is_err()
    );
    assert!(
        visible
            .validate_persisted_value(&SettingValue::Boolean(true))
            .is_err()
    );

    let secret = SettingSchema::Text {
        default: String::new(),
        min_bytes: 0,
        max_bytes: 8,
        secret: true,
    };
    assert!(
        secret
            .validate_persisted_value(&SettingValue::Text("secret".into()))
            .is_err()
    );

    let invalid_integer = SettingSchema::Integer {
        default: 0,
        min: 0,
        max: 10,
        step: 0,
    };
    assert!(
        invalid_integer
            .validate_persisted_value(&SettingValue::Integer(2))
            .is_err()
    );
    let full_range = SettingSchema::Integer {
        default: i64::MIN,
        min: i64::MIN,
        max: i64::MAX,
        step: 1,
    };
    assert!(
        full_range
            .validate_persisted_value(&SettingValue::Integer(i64::MAX))
            .is_ok()
    );
}
