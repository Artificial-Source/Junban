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
    include_bytes!("../tests/fixtures/guest-valid.wasm").to_vec()
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

fn append_name_section(component: &mut Vec<u8>, data_len: usize) {
    component.push(0);
    leb(1 + 4 + data_len, component);
    component.push(4);
    component.extend_from_slice(b"name");
    component.resize(component.len() + data_len, 0);
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

fn valid_package() -> Vec<u8> {
    let component = valid_component();
    pack_package(&valid_manifest(&component), &component, &test_key()).unwrap()
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
        "f31351a3ed17d202c79656a564b864b9bea381c4482d986530cbc2fdc6de0514"
    );
    assert_eq!(
        hex(&sha256(&component)),
        "f6ef73957f342ea0291739c73a22f5f63ea0a97b1bbd5969af6ae4fd8add5ca8"
    );
    let inspection = inspect_component(&component, &valid_manifest(&component)).unwrap();
    assert!(inspection.imports.is_empty());
    assert_eq!(inspection.exports, [REQUIRED_GUEST_EXPORT]);
    assert_eq!(inspection.guest_abi_sha256.len(), 64);
}

#[test]
fn deterministic_valid_package_round_trips_and_full_inspects() {
    let first = valid_package();
    let second = valid_package();
    assert_eq!(first, second);
    assert_eq!(
        hex(&sha256(&first)),
        "736af8351f3c7fea35b6548ed4e0f80c13cae14ddd5f91698773e8e37f4a0a39"
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
    let manifest = valid_manifest(&component);
    assert!(matches!(
        inspect_component(core, &manifest),
        Err(SdkError::ComponentEncoding)
    ));
    assert!(inspect_component(b"bad wasm", &manifest).is_err());
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
    let alternate_manifest = valid_manifest(&alternate_export);
    assert!(matches!(
        inspect_component(&alternate_export, &alternate_manifest),
        Err(SdkError::ComponentAuthority { field: "exports" })
    ));

    let mismatched = include_bytes!("../tests/fixtures/guest-signature-mismatch.wasm").to_vec();
    let mut mismatch_manifest = valid_manifest(&mismatched);
    mismatch_manifest.component_sha256 = hex(&sha256(&mismatched));
    assert!(matches!(
        inspect_component(&mismatched, &mismatch_manifest),
        Err(SdkError::ComponentAuthority { field: "guest ABI" })
    ));

    let imported = include_bytes!("../tests/fixtures/guest-host-tasks.wasm").to_vec();
    let mut wrong_import_abi = imported.clone();
    replace_all_equal(&mut wrong_import_abi, b"query-tasks", b"query-fasks");
    assert!(matches!(
        inspect_component(&wrong_import_abi, &valid_manifest(&wrong_import_abi)),
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
    let unknown_manifest = valid_manifest(&unknown_import);
    assert!(matches!(
        inspect_component(&unknown_import, &unknown_manifest),
        Err(SdkError::ComponentAuthority {
            field: "unknown import"
        })
    ));
    let no_grant = valid_manifest(&imported);
    assert!(matches!(
        inspect_component(&imported, &no_grant),
        Err(SdkError::ComponentAuthority {
            field: "undeclared import"
        })
    ));
    let mut granted = no_grant;
    granted.permissions.push(Permission {
        capability: Capability::TasksRead,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    });
    assert!(inspect_component(&imported, &granted).is_ok());

    let mut rust_profile = valid_manifest(&component);
    rust_profile.runtime_profile = RuntimeProfile::Rust;
    assert!(matches!(
        inspect_component(&component, &rust_profile),
        Err(SdkError::ComponentAuthority {
            field: "runtime profile imports"
        })
    ));
    let rust_component = include_bytes!("../tests/fixtures/guest-rust-baseline.wasm").to_vec();
    rust_profile.component_sha256 = hex(&sha256(&rust_component));
    let rust_inspection = inspect_component(&rust_component, &rust_profile).unwrap();
    assert_eq!(rust_inspection.imports, RUST_WASI_BASELINE);
    assert_eq!(
        hex(&sha256(&rust_component)),
        "c6f30603d464ab04e5e4fda49529b33e375c0bfdc505e57068e6f1fd0a2d0ad4"
    );
    assert_eq!(
        hex(&sha256(
            &pack_package(&rust_profile, &rust_component, &test_key()).unwrap()
        )),
        "3ee8c8a5264e2bef6c655bf207c2099cc83521cfd6fffa008a1f2b9d77367b5c"
    );
    assert_eq!(
        hex(&sha256(&imported)),
        "935d6a3bc571f3eeb230aa70a1c772911ec70e5bf98604cb155239f48c6c4f45"
    );
    assert_eq!(
        hex(&sha256(
            &pack_package(&granted, &imported, &test_key()).unwrap()
        )),
        "8589329f72034384be959157516ed2c583563c9788dfcb4293f8ef3c04951560"
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
    changed.runtime_profile = RuntimeProfile::Rust;
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
        protocol_version: HOST_PROTOCOL_VERSION + 1,
        host_session_id: "00000000-0000-4000-8000-000000000001".into(),
    };
    assert!(encode_parent_frame(&invalid).is_err());
    let invalid_payload = serde_json::to_vec(&invalid).unwrap();
    let mut invalid_frame = Vec::new();
    invalid_frame.extend_from_slice(&u32::try_from(invalid_payload.len()).unwrap().to_be_bytes());
    invalid_frame.extend_from_slice(&invalid_payload);
    assert!(decode_parent_frame(&invalid_frame).is_err());
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
    let child = ChildFrame::Failed {
        fence: None,
        code: HostFailureCode::Unavailable,
    };
    let encoded_child = encode_child_frame(&child).unwrap();
    assert_eq!(decode_child_frame(&encoded_child).unwrap(), child);
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
    assert_eq!(authority.fingerprint, PRODUCT_ENTRYPOINT_FINGERPRINT);
    assert_eq!(authority.marker, product_linkage_marker());
    assert!(authority.authority_type_sizes.iter().all(|size| *size > 0));
    assert_eq!(IMPORT_AUTHORITIES.len(), 9);
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
