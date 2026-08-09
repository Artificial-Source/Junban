use std::{
    io::{Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

use junban_plugin_sdk::{
    AuthorityFence, CallbackFence, Capability, ChildFrame, HOST_CALLBACK_BODY_BYTES_MAX,
    HOST_CONCURRENT_INVOCATIONS_MAX, HOST_FRAME_BYTES_MAX, HOST_JUNBAN_VERSION, HOST_PROTOCOL_NAME,
    HOST_PROTOCOL_VERSION, HOST_RUNTIME_ENTRIES_MAX, HostCallKind, HostCallReply, HostCallRequest,
    HostFailureCode, InvocationOutcome, InvocationRequest, ParentFrame, Permission,
    PermissionScope, RuntimeLimits, RuntimeProfile, ServiceConsumeScope, ServiceReference,
    UnscopedPermission, canonical_permission_hash, child_body_len, decode_child_frame,
    decode_host_call_request, decode_invocation_outcome, encode_parent_frame,
    inspect_component_for_runtime, private_body_types as body, validate_child_body,
};
use sha2::{Digest, Sha256};

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const LOAD_INVOCATION: &str = "00000000-0000-4000-8000-000000000002";
const TYPESCRIPT_COMPONENT: &[u8] = include_bytes!(
    "../../junban-plugin-sdk/consumers/typescript/artifacts/typescript-consumer.wasm"
);
const RUST_COMPONENT: &[u8] =
    include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");

struct HostProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl HostProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_junban-plugin-host"))
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        Self {
            child,
            stdin,
            stdout,
        }
    }

    fn send_header(&mut self, frame: &ParentFrame) {
        self.stdin
            .write_all(&encode_parent_frame(frame).unwrap())
            .unwrap();
        self.stdin.flush().unwrap();
    }

    fn send(&mut self, frame: &ParentFrame, body: &[u8]) {
        self.send_header(frame);
        self.stdin.write_all(body).unwrap();
        self.stdin.flush().unwrap();
    }

    fn receive(&mut self) -> (ChildFrame, Vec<u8>) {
        let mut prefix = [0; 4];
        self.stdout.read_exact(&mut prefix).unwrap();
        let header_len = u32::from_be_bytes(prefix) as usize;
        assert!((1..=HOST_FRAME_BYTES_MAX).contains(&header_len));
        let mut encoded = vec![0; 4 + header_len];
        encoded[..4].copy_from_slice(&prefix);
        self.stdout.read_exact(&mut encoded[4..]).unwrap();
        let frame = decode_child_frame(&encoded).unwrap();
        let mut body = vec![0; child_body_len(&frame).unwrap()];
        self.stdout.read_exact(&mut body).unwrap();
        validate_child_body(&frame, &body).unwrap();
        (frame, body)
    }

    fn hello(&mut self) {
        self.send(
            &ParentFrame::Hello {
                protocol_name: HOST_PROTOCOL_NAME.into(),
                protocol_version: HOST_PROTOCOL_VERSION,
                junban_version: HOST_JUNBAN_VERSION.into(),
                host_session_id: SESSION.into(),
            },
            &[],
        );
        assert_eq!(
            self.receive(),
            (
                ChildFrame::Hello {
                    protocol_name: HOST_PROTOCOL_NAME.into(),
                    protocol_version: HOST_PROTOCOL_VERSION,
                    junban_version: HOST_JUNBAN_VERSION.into(),
                    host_session_id: SESSION.into(),
                },
                Vec::new(),
            )
        );
    }

    fn reply(&mut self, callback: junban_plugin_sdk::CallbackFence, reply: HostCallReply) {
        let message = reply.into_parent_message(callback).unwrap();
        let (frame, body) = message.into_parts();
        self.send(&frame, &body);
    }

    fn invoke(
        &mut self,
        request: InvocationRequest,
        invocation_id: &str,
        permission_hash: &str,
    ) -> (AuthorityFence, ChildFrame, Vec<u8>) {
        let invoke_fence = fence(invocation_id);
        let message = request
            .into_parent_message(invoke_fence.clone(), permission_hash.to_owned())
            .unwrap();
        let (frame, request_body) = message.into_parts();
        self.send(&frame, &request_body);
        let (frame, response_body) = self.receive();
        (invoke_fence, frame, response_body)
    }

    fn finish_with_status(mut self, expect_success: bool) -> Vec<u8> {
        drop(self.stdin);
        let status = self.child.wait().unwrap();
        assert_eq!(status.success(), expect_success, "unexpected child status");
        let mut stderr = Vec::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_end(&mut stderr)
            .unwrap();
        stderr
    }

    fn finish(self) {
        assert!(
            self.finish_with_status(true).is_empty(),
            "child diagnostics were not empty"
        );
    }

    fn send_malformed_frame(&mut self) {
        self.stdin.write_all(&0_u32.to_be_bytes()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn shutdown(mut self) {
        self.send(
            &ParentFrame::Shutdown {
                host_session_id: SESSION.into(),
            },
            &[],
        );
        assert_eq!(
            self.receive(),
            (
                ChildFrame::ShutdownComplete {
                    host_session_id: SESSION.into(),
                },
                Vec::new(),
            )
        );
        drop(self.stdin);
        assert!(self.child.wait().unwrap().success());
        let mut stderr = Vec::new();
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_end(&mut stderr)
            .unwrap();
        assert!(stderr.is_empty(), "child diagnostics were not empty");
    }
}

fn fence(invocation_id: &str) -> AuthorityFence {
    plugin_fence("test-plugin", invocation_id)
}

fn plugin_fence(plugin_id: &str, invocation_id: &str) -> AuthorityFence {
    AuthorityFence {
        plugin_id: plugin_id.into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: invocation_id.into(),
    }
}

fn invocation_id(value: usize) -> String {
    format!("00000000-0000-4000-8000-{value:012}")
}

fn permissions() -> Vec<Permission> {
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

/// Retained TypeScript consumer grants: the shared four plus the scoped
/// `services:consume` authority its host-services import requires. Sorted
/// canonically so `canonical_permission_hash` accepts the set.
fn typescript_permissions() -> Vec<Permission> {
    let mut grants = permissions();
    grants.insert(
        1,
        Permission {
            capability: Capability::ServicesConsume,
            scope: PermissionScope::Services(ServiceConsumeScope {
                services: vec![ServiceReference {
                    plugin_id: "dependency".into(),
                    service_id: "service".into(),
                }],
            }),
        },
    );
    grants
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn load_rust_plugin(
    host: &mut HostProcess,
    plugin_id: &str,
    invocation_id: &str,
    import_export_fingerprint: &str,
) -> String {
    let grants = permissions();
    let permission_hash = canonical_permission_hash(&grants).unwrap();
    let fence = plugin_fence(plugin_id, invocation_id);
    host.send(
        &ParentFrame::Load {
            fence: fence.clone(),
            package_sha256: "4".repeat(64),
            component_sha256: sha256(RUST_COMPONENT),
            import_export_fingerprint: import_export_fingerprint.into(),
            runtime_profile: RuntimeProfile::Rust,
            component_size: RUST_COMPONENT.len() as u64,
            grants,
            permission_hash: permission_hash.clone(),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
        },
        RUST_COMPONENT,
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Loaded {
                fence,
                import_export_fingerprint: import_export_fingerprint.into(),
            },
            Vec::new(),
        )
    );
    permission_hash
}

fn send_plugin_request(
    host: &mut HostProcess,
    plugin_id: &str,
    invocation_id: &str,
    permission_hash: &str,
    request: InvocationRequest,
) -> AuthorityFence {
    let fence = plugin_fence(plugin_id, invocation_id);
    let message = request
        .into_parent_message(fence.clone(), permission_hash.into())
        .unwrap();
    let (frame, body) = message.into_parts();
    host.send(&frame, &body);
    fence
}

fn expect_outcome(frame: ChildFrame, bytes: &[u8]) -> InvocationOutcome {
    let ChildFrame::Outcome { kind, .. } = frame else {
        panic!("expected typed outcome, got {frame:?}");
    };
    decode_invocation_outcome(kind, bytes).unwrap()
}

fn expect_capability(
    frame: ChildFrame,
    bytes: &[u8],
) -> (junban_plugin_sdk::CallbackFence, HostCallRequest) {
    let ChildFrame::CapabilityRequest { callback, kind, .. } = frame else {
        panic!("expected capability request, got {frame:?}");
    };
    let request = decode_host_call_request(kind, bytes).unwrap();
    (callback, request)
}

fn complete_activation(
    host: &mut HostProcess,
    plugin_id: &str,
    invocation_id: &str,
    permission_hash: &str,
) {
    send_plugin_request(
        host,
        plugin_id,
        invocation_id,
        permission_hash,
        InvocationRequest::activate(None),
    );
    let (frame, bytes) = host.receive();
    let (settings, request) = expect_capability(frame, &bytes);
    assert_eq!(request, HostCallRequest::GetSettings(()));
    host.reply(
        settings,
        HostCallReply::GetSettings(body::WitResult::Ok(Vec::new())),
    );

    let (frame, bytes) = host.receive();
    let (get_kv, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::GetKv(_)));
    host.reply(
        get_kv,
        HostCallReply::GetKv(body::WitResult::Ok(Vec::new())),
    );

    let (frame, bytes) = host.receive();
    let (list_kv, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::ListKv(_)));
    host.reply(
        list_kv,
        HostCallReply::ListKv(body::WitResult::Ok(body::KvPage {
            entries: Vec::new(),
            next_cursor: None,
        })),
    );

    let (frame, bytes) = host.receive();
    let (log, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::Log(_)));
    host.reply(log, HostCallReply::Log(()));

    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::Activate(body::WitResult::Ok(()))
    );
}

fn expect_service_state(host: &mut HostProcess, activation_count: i64) {
    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::CallService(body::WitResult::Ok(body::ServiceData {
            values: vec![body::NamedValue {
                name: "activation-count".into(),
                value: body::DataValue::Scalar(body::ScalarValue::IntegerValue(activation_count)),
            }],
        }))
    );
}

#[test]
fn retained_typescript_invokes_all_exports_and_contains_oversized_import() {
    let grants = typescript_permissions();
    let inspection =
        inspect_component_for_runtime(TYPESCRIPT_COMPONENT, RuntimeProfile::Typescript, &grants)
            .unwrap();
    let load_fence = fence(LOAD_INVOCATION);
    let permission_hash = canonical_permission_hash(&grants).unwrap();
    let frame = ParentFrame::Load {
        fence: load_fence.clone(),
        package_sha256: "1".repeat(64),
        component_sha256: sha256(TYPESCRIPT_COMPONENT),
        import_export_fingerprint: inspection.import_export_fingerprint.clone(),
        runtime_profile: RuntimeProfile::Typescript,
        component_size: TYPESCRIPT_COMPONENT.len() as u64,
        grants,
        permission_hash: permission_hash.clone(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
    };

    let mut host = HostProcess::spawn();
    host.hello();
    host.send(&frame, TYPESCRIPT_COMPONENT);
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Loaded {
                fence: load_fence,
                import_export_fingerprint: inspection.import_export_fingerprint,
            },
            Vec::new(),
        )
    );
    let activate_one = host.invoke(
        InvocationRequest::activate(None),
        "00000000-0000-4000-8000-000000000003",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(activate_one.1, &activate_one.2),
        InvocationOutcome::Activate(body::WitResult::Ok(()))
    );
    let activate_two = host.invoke(
        InvocationRequest::activate(Some("second".into())),
        "00000000-0000-4000-8000-000000000004",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(activate_two.1, &activate_two.2),
        InvocationOutcome::Activate(body::WitResult::Ok(()))
    );

    let deactivate = host.invoke(
        InvocationRequest::deactivate(None),
        "00000000-0000-4000-8000-000000000005",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(deactivate.1, &deactivate.2),
        InvocationOutcome::Deactivate(body::WitResult::Ok(()))
    );

    let command = host.invoke(
        InvocationRequest::invoke_command(
            Some("command".into()),
            body::CommandCall {
                command_id: "command".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-000000000006",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(command.1, &command.2),
        InvocationOutcome::InvokeCommand(body::WitResult::Ok(body::PluginOutcome { effect: None }))
    );

    let event = host.invoke(
        InvocationRequest::handle_event(
            Some("event".into()),
            body::EventEnvelope {
                event_epoch: "epoch".into(),
                revision: 1,
                kind: body::EventKind::TaskDeleted,
                subject: body::EventSubject::DeletedTask("task".into()),
            },
        ),
        "00000000-0000-4000-8000-000000000007",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(event.1, &event.2),
        InvocationOutcome::HandleEvent(body::WitResult::Ok(body::PluginOutcome { effect: None }))
    );

    let surface = host.invoke(
        InvocationRequest::render_surface(
            Some("surface".into()),
            body::SurfaceRequest {
                surface_id: "surface".into(),
            },
        ),
        "00000000-0000-4000-8000-000000000008",
        &permission_hash,
    );
    assert!(matches!(
        expect_outcome(surface.1, &surface.2),
        InvocationOutcome::RenderSurface(body::WitResult::Ok(body::Surface {
            surface_id,
            root_index: 0,
            ..
        })) if surface_id == "surface"
    ));

    let action = host.invoke(
        InvocationRequest::handle_surface_action(
            Some("action".into()),
            body::SurfaceAction {
                surface_id: "surface".into(),
                action_id: "action".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-000000000009",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(action.1, &action.2),
        InvocationOutcome::HandleSurfaceAction(body::WitResult::Ok(body::PluginOutcome {
            effect: None,
        }))
    );

    let settings = host.invoke(
        InvocationRequest::validate_settings(None, body::SettingValues { values: Vec::new() }),
        "00000000-0000-4000-8000-00000000000a",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(settings.1, &settings.2),
        InvocationOutcome::ValidateSettings(body::WitResult::Ok(Vec::new()))
    );

    let resync = host.invoke(
        InvocationRequest::resync(
            Some("resync".into()),
            body::ResyncPage::Finalize(body::FinalizeResync {
                session_id: "resync-session".into(),
            }),
        ),
        "00000000-0000-4000-8000-00000000000b",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(resync.1, &resync.2),
        InvocationOutcome::Resync(body::WitResult::Ok(body::ResyncPageOutcome::Finalized(
            body::FinalizedResync {
                session_id: "resync-session".into(),
                choice: body::FinalKvChoice::LeaveKv,
            }
        )))
    );

    let service = host.invoke(
        InvocationRequest::call_service(
            Some("service".into()),
            body::ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "service".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-00000000000c",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(service.1, &service.2),
        InvocationOutcome::CallService(body::WitResult::Ok(body::ServiceData {
            values: vec![body::NamedValue {
                name: "activation-count".into(),
                value: body::DataValue::Scalar(body::ScalarValue::IntegerValue(2)),
            }],
        }))
    );

    let guest_error = host.invoke(
        InvocationRequest::invoke_command(
            Some("guest-error".into()),
            body::CommandCall {
                command_id: "guest-error".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-00000000000d",
        &permission_hash,
    );
    assert!(matches!(
        expect_outcome(guest_error.1, &guest_error.2),
        InvocationOutcome::InvokeCommand(body::WitResult::Err(body::PluginError {
            code: body::ErrorCode::InvalidInput,
            ..
        }))
    ));

    // Omission control: the equivalent compact canonical callback body for the
    // hostile service call stays below the 4-MiB protocol cap, so only the
    // explicit Store hostcall fuel can reject this transfer before publication.
    let control = HostCallRequest::CallService(body::ServiceCall {
        plugin_id: "dependency".into(),
        service_id: "service".into(),
        values: vec![body::NamedValue {
            name: "payload".into(),
            value: body::DataValue::IntegerList(vec![0; 558_081]),
        }],
    })
    .into_child_message(CallbackFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: "00000000-0000-4000-8000-000000000099".into(),
        callback_id: 1,
    })
    .unwrap();
    assert!(control.body().len() < HOST_CALLBACK_BODY_BYTES_MAX);

    // The hostile import runs on the original healthy Store before any
    // deliberate trap or replacement. The guest lowers its 558,081-element
    // BigInt64Array through the bulk typed-array path, and the 4,464,648
    // canonical flat bytes exhaust hostcall fuel during argument lifting.
    // Receiving the terminal failure as the direct response proves no
    // CapabilityRequest was published.
    let hostcall_oversized = host.invoke(
        InvocationRequest::invoke_command(
            Some("hostcall-oversized-import".into()),
            body::CommandCall {
                command_id: "hostcall-oversized-import".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-00000000000f",
        &permission_hash,
    );
    assert_eq!(
        (hostcall_oversized.1, hostcall_oversized.2),
        (
            ChildFrame::Failed {
                fence: hostcall_oversized.0,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );

    let trap = host.invoke(
        InvocationRequest::invoke_command(
            Some("trap".into()),
            body::CommandCall {
                command_id: "trap".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-00000000000e",
        &permission_hash,
    );
    assert_eq!(
        (trap.1, trap.2),
        (
            ChildFrame::Failed {
                fence: trap.0,
                code: HostFailureCode::GuestError,
            },
            Vec::new(),
        )
    );

    let hostcall_replacement = host.invoke(
        InvocationRequest::call_service(
            None,
            body::ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "service".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-000000000010",
        &permission_hash,
    );
    assert!(matches!(
        expect_outcome(hostcall_replacement.1, &hostcall_replacement.2),
        InvocationOutcome::CallService(body::WitResult::Ok(body::ServiceData { values }))
            if values == vec![body::NamedValue {
                name: "activation-count".into(),
                value: body::DataValue::Scalar(body::ScalarValue::IntegerValue(0)),
            }]
    ));

    let oversized = host.invoke(
        InvocationRequest::invoke_command(
            Some("oversized-output".into()),
            body::CommandCall {
                command_id: "oversized-output".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-000000000011",
        &permission_hash,
    );
    assert_eq!(
        (oversized.1, oversized.2),
        (
            ChildFrame::Failed {
                fence: oversized.0,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );

    let spin = host.invoke(
        InvocationRequest::invoke_command(
            Some("spin".into()),
            body::CommandCall {
                command_id: "spin".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-000000000012",
        &permission_hash,
    );
    let (spin_fence, spin_frame, spin_body) = spin;
    assert_eq!(spin_body, Vec::<u8>::new());
    match spin_frame {
        ChildFrame::Failed { fence, code } => {
            assert_eq!(fence, spin_fence);
            assert!(
                matches!(
                    code,
                    HostFailureCode::ResourceLimit | HostFailureCode::Timeout
                ),
                "spin expected concurrent-limit terminal ResourceLimit or Timeout, got {code:?}"
            );
        }
        other => panic!(
            "spin expected Failed with concurrent-limit terminal ResourceLimit or Timeout, got {other:?}"
        ),
    }

    let wall_spin = host.invoke(
        InvocationRequest::handle_event(
            None,
            body::EventEnvelope {
                event_epoch: "spin".into(),
                revision: 1,
                kind: body::EventKind::TaskDeleted,
                subject: body::EventSubject::DeletedTask("task".into()),
            },
        ),
        "00000000-0000-4000-8000-000000000013",
        &permission_hash,
    );
    assert_eq!(
        (wall_spin.1, wall_spin.2),
        (
            ChildFrame::Failed {
                fence: wall_spin.0,
                code: HostFailureCode::Timeout,
            },
            Vec::new(),
        )
    );

    let replacement = host.invoke(
        InvocationRequest::call_service(
            None,
            body::ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "service".into(),
                values: Vec::new(),
            },
        ),
        "00000000-0000-4000-8000-000000000014",
        &permission_hash,
    );
    assert_eq!(
        expect_outcome(replacement.1, &replacement.2),
        InvocationOutcome::CallService(body::WitResult::Ok(body::ServiceData {
            values: vec![body::NamedValue {
                name: "activation-count".into(),
                value: body::DataValue::Scalar(body::ScalarValue::IntegerValue(0)),
            }],
        }))
    );
    host.shutdown();
}

#[test]
fn retained_typescript_table_pressure_fails_at_the_store_limit() {
    let mut component = TYPESCRIPT_COMPONENT.to_vec();
    let table = [0x01, 0x70, 0x01, 0x8d, 0x3c, 0x8d, 0x3c];
    let offsets = component
        .windows(table.len())
        .enumerate()
        .filter_map(|(offset, window)| (window == table).then_some(offset))
        .collect::<Vec<_>>();
    assert_eq!(offsets.len(), 1, "retained table authority drifted");
    let offset = offsets[0];
    component[offset + 3..offset + 5].copy_from_slice(&[0x91, 0x4e]);
    component[offset + 5..offset + 7].copy_from_slice(&[0x91, 0x4e]);

    let grants = typescript_permissions();
    let inspection =
        inspect_component_for_runtime(&component, RuntimeProfile::Typescript, &grants).unwrap();
    let load_fence = fence("00000000-0000-4000-8000-000000000002");
    let frame = ParentFrame::Load {
        fence: load_fence.clone(),
        package_sha256: "1".repeat(64),
        component_sha256: sha256(&component),
        import_export_fingerprint: inspection.import_export_fingerprint,
        runtime_profile: RuntimeProfile::Typescript,
        component_size: component.len() as u64,
        grants: grants.clone(),
        permission_hash: canonical_permission_hash(&grants).unwrap(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
    };

    let mut host = HostProcess::spawn();
    host.hello();
    host.send(&frame, &component);
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: load_fence,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );
    host.finish();
}

#[test]
fn retained_rust_callbacks_reject_mismatch_and_preserve_serial_authority() {
    let grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &grants).unwrap();
    let permission_hash = canonical_permission_hash(&grants).unwrap();
    let load_fence = fence(LOAD_INVOCATION);
    let mut host = HostProcess::spawn();
    host.hello();
    host.send(
        &ParentFrame::Load {
            fence: load_fence.clone(),
            package_sha256: "2".repeat(64),
            component_sha256: sha256(RUST_COMPONENT),
            import_export_fingerprint: inspection.import_export_fingerprint.clone(),
            runtime_profile: RuntimeProfile::Rust,
            component_size: RUST_COMPONENT.len() as u64,
            grants,
            permission_hash: permission_hash.clone(),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
        },
        RUST_COMPONENT,
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Loaded {
                fence: load_fence,
                import_export_fingerprint: inspection.import_export_fingerprint,
            },
            Vec::new(),
        )
    );

    let active_fence = fence("00000000-0000-4000-8000-000000000010");
    let active = InvocationRequest::activate(None)
        .into_parent_message(active_fence.clone(), permission_hash.clone())
        .unwrap();
    let (active_frame, active_body) = active.into_parts();
    host.send(&active_frame, &active_body);
    let (request_frame, request_body) = host.receive();
    let (settings_callback, settings_request) = expect_capability(request_frame, &request_body);
    assert_eq!(settings_request, HostCallRequest::GetSettings(()));
    assert_eq!(settings_callback.callback_id, 1);

    let busy_fence = fence("00000000-0000-4000-8000-000000000011");
    let busy = InvocationRequest::activate(None)
        .into_parent_message(busy_fence.clone(), permission_hash.clone())
        .unwrap();
    let (busy_frame, busy_body) = busy.into_parts();
    host.send(&busy_frame, &busy_body);
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: busy_fence,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );

    let settings_error = HostCallReply::GetSettings(body::WitResult::Err(body::HostError {
        code: body::ErrorCode::Unavailable,
        field: None,
        message: "not available".into(),
    }));
    let mut stale_callback = settings_callback.clone();
    stale_callback.invocation_id = "00000000-0000-4000-8000-000000000099".into();
    host.reply(stale_callback.clone(), settings_error.clone());
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: stale_callback.authority(),
                code: HostFailureCode::StaleAuthority,
            },
            Vec::new(),
        )
    );

    host.reply(
        settings_callback.clone(),
        HostCallReply::Cancelled(HostCallKind::QueryProjects),
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: settings_callback.authority(),
                code: HostFailureCode::InvalidFrame,
            },
            Vec::new(),
        )
    );

    host.reply(settings_callback, settings_error);

    let (storage_frame, storage_body) = host.receive();
    let (storage_callback, storage_request) = expect_capability(storage_frame, &storage_body);
    assert!(matches!(storage_request, HostCallRequest::GetKv(_)));
    assert_eq!(storage_callback.callback_id, 2);
    host.reply(
        storage_callback,
        HostCallReply::Cancelled(HostCallKind::GetKv),
    );

    let (list_frame, list_body) = host.receive();
    let (list_callback, list_request) = expect_capability(list_frame, &list_body);
    assert!(matches!(list_request, HostCallRequest::ListKv(_)));
    assert_eq!(list_callback.callback_id, 3);
    host.reply(
        list_callback,
        HostCallReply::ListKv(body::WitResult::Ok(body::KvPage {
            entries: Vec::new(),
            next_cursor: None,
        })),
    );

    let (log_frame, log_body) = host.receive();
    let (log_callback, log_request) = expect_capability(log_frame, &log_body);
    assert!(matches!(log_request, HostCallRequest::Log(_)));
    assert_eq!(log_callback.callback_id, 4);
    host.reply(log_callback, HostCallReply::Log(()));

    let (activate_outcome_frame, activate_outcome_body) = host.receive();
    assert_eq!(
        expect_outcome(activate_outcome_frame, &activate_outcome_body),
        InvocationOutcome::Activate(body::WitResult::Ok(()))
    );

    let command_fence = fence("00000000-0000-4000-8000-000000000014");
    let command = InvocationRequest::invoke_command(
        Some("command".into()),
        body::CommandCall {
            command_id: "command".into(),
            values: Vec::new(),
        },
    )
    .into_parent_message(command_fence, permission_hash.clone())
    .unwrap();
    let (command_frame, command_body) = command.into_parts();
    host.send(&command_frame, &command_body);
    let (query_frame, query_body) = host.receive();
    let (query_callback, query_request) = expect_capability(query_frame, &query_body);
    assert!(matches!(query_request, HostCallRequest::QueryTasks(_)));
    assert_eq!(query_callback.callback_id, 1);
    let query_success = HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
        items: Vec::new(),
        next_cursor: None,
        revision: 1,
    }));
    host.reply(query_callback.clone(), query_success.clone());

    let (command_outcome_frame, command_outcome_body) = host.receive();
    assert_eq!(
        expect_outcome(command_outcome_frame, &command_outcome_body),
        InvocationOutcome::InvokeCommand(body::WitResult::Ok(body::PluginOutcome { effect: None }))
    );

    host.reply(query_callback.clone(), query_success);
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: query_callback.authority(),
                code: HostFailureCode::StaleAuthority,
            },
            Vec::new(),
        )
    );

    let unload_fence = fence("00000000-0000-4000-8000-000000000012");
    host.send(
        &ParentFrame::Unload {
            fence: unload_fence.clone(),
        },
        &[],
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Unloaded {
                fence: unload_fence,
            },
            Vec::new(),
        )
    );

    let stale_fence = fence("00000000-0000-4000-8000-000000000013");
    let stale = InvocationRequest::activate(None)
        .into_parent_message(stale_fence.clone(), permission_hash)
        .unwrap();
    let (stale_frame, _) = stale.into_parts();
    host.send_header(&stale_frame);
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: stale_fence,
                code: HostFailureCode::StaleAuthority,
            },
            Vec::new(),
        )
    );
    host.finish();
}

#[test]
fn one_child_admits_sixteen_entries_rejects_the_seventeenth_and_reuses_unloaded_capacity() {
    assert_eq!(HOST_RUNTIME_ENTRIES_MAX, 16);
    let grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &grants).unwrap();
    let fingerprint = inspection.import_export_fingerprint;
    let mut host = HostProcess::spawn();
    host.hello();

    for index in 0..HOST_RUNTIME_ENTRIES_MAX {
        load_rust_plugin(
            &mut host,
            &format!("plugin-{index:02}"),
            &invocation_id(100 + index),
            &fingerprint,
        );
    }

    let unload_fence = plugin_fence("plugin-07", &invocation_id(200));
    host.send(
        &ParentFrame::Unload {
            fence: unload_fence.clone(),
        },
        &[],
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Unloaded {
                fence: unload_fence,
            },
            Vec::new(),
        )
    );
    load_rust_plugin(
        &mut host,
        "plugin-replacement",
        &invocation_id(201),
        &fingerprint,
    );

    let overflow_fence = plugin_fence("plugin-overflow", &invocation_id(202));
    let overflow_grants = permissions();
    host.send_header(&ParentFrame::Load {
        fence: overflow_fence.clone(),
        package_sha256: "4".repeat(64),
        component_sha256: sha256(RUST_COMPONENT),
        import_export_fingerprint: fingerprint.clone(),
        runtime_profile: RuntimeProfile::Rust,
        component_size: RUST_COMPONENT.len() as u64,
        permission_hash: canonical_permission_hash(&overflow_grants).unwrap(),
        grants: overflow_grants,
        limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
    });
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: overflow_fence,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );
    host.finish();
}

#[test]
fn duplicate_and_stale_loads_fail_closed_for_the_complete_session() {
    let grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &grants).unwrap();
    let fingerprint = inspection.import_export_fingerprint;

    let mut duplicate_host = HostProcess::spawn();
    duplicate_host.hello();
    load_rust_plugin(
        &mut duplicate_host,
        "duplicate-plugin",
        &invocation_id(210),
        &fingerprint,
    );
    let duplicate_fence = plugin_fence("duplicate-plugin", &invocation_id(211));
    let duplicate_grants = permissions();
    duplicate_host.send_header(&ParentFrame::Load {
        fence: duplicate_fence.clone(),
        package_sha256: "4".repeat(64),
        component_sha256: sha256(RUST_COMPONENT),
        import_export_fingerprint: fingerprint.clone(),
        runtime_profile: RuntimeProfile::Rust,
        component_size: RUST_COMPONENT.len() as u64,
        permission_hash: canonical_permission_hash(&duplicate_grants).unwrap(),
        grants: duplicate_grants,
        limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
    });
    assert_eq!(
        duplicate_host.receive(),
        (
            ChildFrame::Failed {
                fence: duplicate_fence,
                code: HostFailureCode::Unavailable,
            },
            Vec::new(),
        )
    );
    duplicate_host.finish();

    let mut stale_host = HostProcess::spawn();
    stale_host.hello();
    load_rust_plugin(
        &mut stale_host,
        "stale-plugin",
        &invocation_id(212),
        &fingerprint,
    );
    let mut stale_fence = plugin_fence("stale-plugin", &invocation_id(213));
    stale_fence.activation_epoch += 1;
    let stale_grants = permissions();
    stale_host.send_header(&ParentFrame::Load {
        fence: stale_fence.clone(),
        package_sha256: "4".repeat(64),
        component_sha256: sha256(RUST_COMPONENT),
        import_export_fingerprint: fingerprint,
        runtime_profile: RuntimeProfile::Rust,
        component_size: RUST_COMPONENT.len() as u64,
        permission_hash: canonical_permission_hash(&stale_grants).unwrap(),
        grants: stale_grants,
        limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
    });
    assert_eq!(
        stale_host.receive(),
        (
            ChildFrame::Failed {
                fence: stale_fence,
                code: HostFailureCode::StaleAuthority,
            },
            Vec::new(),
        )
    );
    stale_host.finish();
}

#[test]
fn multi_entry_eof_and_malformed_input_join_every_worker() {
    let grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &grants).unwrap();
    let fingerprint = inspection.import_export_fingerprint;

    let mut eof_host = HostProcess::spawn();
    eof_host.hello();
    load_rust_plugin(&mut eof_host, "eof-a", &invocation_id(220), &fingerprint);
    load_rust_plugin(&mut eof_host, "eof-b", &invocation_id(221), &fingerprint);
    eof_host.finish();

    let mut malformed_host = HostProcess::spawn();
    malformed_host.hello();
    load_rust_plugin(
        &mut malformed_host,
        "malformed-a",
        &invocation_id(222),
        &fingerprint,
    );
    load_rust_plugin(
        &mut malformed_host,
        "malformed-b",
        &invocation_id(223),
        &fingerprint,
    );
    malformed_host.send_malformed_frame();
    assert_eq!(
        malformed_host.finish_with_status(false),
        b"junban-plugin-host: protocol input rejected\n"
    );
}

#[test]
fn nested_and_parallel_invocations_obey_per_plugin_and_child_admission() {
    assert_eq!(HOST_CONCURRENT_INVOCATIONS_MAX, 4);
    let grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &grants).unwrap();
    let fingerprint = inspection.import_export_fingerprint;
    let mut host = HostProcess::spawn();
    host.hello();
    let mut hashes = Vec::new();
    for plugin_id in [
        "caller",
        "dependency",
        "parallel-2",
        "parallel-3",
        "parallel-4",
    ] {
        hashes.push((
            plugin_id,
            load_rust_plugin(
                &mut host,
                plugin_id,
                &invocation_id(300 + hashes.len()),
                &fingerprint,
            ),
        ));
    }

    let command = || {
        InvocationRequest::invoke_command(
            None,
            body::CommandCall {
                command_id: "normal".into(),
                values: Vec::new(),
            },
        )
    };
    let caller = send_plugin_request(
        &mut host,
        "caller",
        &invocation_id(310),
        &hashes[0].1,
        command(),
    );
    let (frame, bytes) = host.receive();
    let (caller_callback, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::QueryTasks(_)));
    assert_eq!(caller_callback.plugin_id, "caller");

    // A dependency invocation arriving while its caller is blocked in a host
    // callback is admitted on its own lane rather than serialized behind it.
    let dependency = send_plugin_request(
        &mut host,
        "dependency",
        &invocation_id(311),
        &hashes[1].1,
        command(),
    );
    let (frame, bytes) = host.receive();
    let (dependency_callback, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::QueryTasks(_)));
    assert_eq!(dependency_callback.plugin_id, "dependency");

    for fence in [caller, dependency] {
        host.send(
            &ParentFrame::Cancel {
                fence: fence.clone(),
            },
            &[],
        );
        assert_eq!(
            host.receive(),
            (ChildFrame::Cancelled { fence }, Vec::new())
        );
    }

    let mut active = Vec::new();
    for (offset, (plugin_id, permission_hash)) in hashes.iter().take(4).enumerate() {
        let fence = send_plugin_request(
            &mut host,
            plugin_id,
            &invocation_id(320 + offset),
            permission_hash,
            command(),
        );
        let (frame, bytes) = host.receive();
        let (callback, request) = expect_capability(frame, &bytes);
        assert!(matches!(request, HostCallRequest::QueryTasks(_)));
        assert_eq!(callback.plugin_id, *plugin_id);
        active.push(fence);
    }

    let fifth = send_plugin_request(
        &mut host,
        "parallel-4",
        &invocation_id(330),
        &hashes[4].1,
        command(),
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: fifth,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );
    let same_plugin = send_plugin_request(
        &mut host,
        "caller",
        &invocation_id(331),
        &hashes[0].1,
        command(),
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: same_plugin,
                code: HostFailureCode::ResourceLimit,
            },
            Vec::new(),
        )
    );

    host.send(
        &ParentFrame::Shutdown {
            host_session_id: SESSION.into(),
        },
        &[],
    );
    // BTreeMap ownership makes complete-child teardown deterministic by
    // PluginId while each entry destroys its Store before its terminal frame.
    for fence in active {
        assert_eq!(
            host.receive(),
            (ChildFrame::Cancelled { fence }, Vec::new())
        );
    }
    assert_eq!(
        host.receive(),
        (
            ChildFrame::ShutdownComplete {
                host_session_id: SESSION.into(),
            },
            Vec::new(),
        )
    );
    host.finish();
}

#[test]
fn timeout_epoch_and_trap_replacement_are_isolated_per_plugin() {
    let grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &grants).unwrap();
    let fingerprint = inspection.import_export_fingerprint;
    let mut host = HostProcess::spawn();
    host.hello();
    let hash_a = load_rust_plugin(&mut host, "plugin-a", &invocation_id(400), &fingerprint);
    let hash_b = load_rust_plugin(&mut host, "plugin-b", &invocation_id(401), &fingerprint);

    complete_activation(&mut host, "plugin-b", &invocation_id(402), &hash_b);
    send_plugin_request(
        &mut host,
        "plugin-b",
        &invocation_id(403),
        &hash_b,
        InvocationRequest::call_service(
            None,
            body::ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "state".into(),
                values: Vec::new(),
            },
        ),
    );
    expect_service_state(&mut host, 1);

    let trap = send_plugin_request(
        &mut host,
        "plugin-a",
        &invocation_id(404),
        &hash_a,
        InvocationRequest::invoke_command(
            None,
            body::CommandCall {
                command_id: "trap".into(),
                values: Vec::new(),
            },
        ),
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: trap,
                code: HostFailureCode::GuestError,
            },
            Vec::new(),
        )
    );
    send_plugin_request(
        &mut host,
        "plugin-b",
        &invocation_id(405),
        &hash_b,
        InvocationRequest::call_service(
            None,
            body::ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "state".into(),
                values: Vec::new(),
            },
        ),
    );
    expect_service_state(&mut host, 1);

    let spin = send_plugin_request(
        &mut host,
        "plugin-a",
        &invocation_id(406),
        &hash_a,
        InvocationRequest::handle_event(
            None,
            body::EventEnvelope {
                event_epoch: "spin".into(),
                revision: 1,
                kind: body::EventKind::TaskDeleted,
                subject: body::EventSubject::DeletedTask("task".into()),
            },
        ),
    );
    let sibling = send_plugin_request(
        &mut host,
        "plugin-b",
        &invocation_id(407),
        &hash_b,
        InvocationRequest::invoke_command(
            None,
            body::CommandCall {
                command_id: "normal".into(),
                values: Vec::new(),
            },
        ),
    );

    let mut sibling_callback = None;
    let mut saw_timeout = false;
    for _ in 0..2 {
        let (frame, bytes) = host.receive();
        match frame {
            ChildFrame::CapabilityRequest { .. } => {
                let (callback, request) = expect_capability(frame, &bytes);
                assert_eq!(callback.plugin_id, "plugin-b");
                assert!(matches!(request, HostCallRequest::QueryTasks(_)));
                sibling_callback = Some(callback);
            }
            ChildFrame::Failed { fence, code } => {
                assert_eq!(fence, spin);
                assert_eq!(code, HostFailureCode::Timeout);
                assert!(bytes.is_empty());
                saw_timeout = true;
            }
            other => panic!("unexpected parallel isolation frame {other:?}"),
        }
    }
    assert!(saw_timeout);
    host.reply(
        sibling_callback.expect("sibling callback was emitted"),
        HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
            items: Vec::new(),
            next_cursor: None,
            revision: 1,
        })),
    );
    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::InvokeCommand(body::WitResult::Ok(body::PluginOutcome { effect: None }))
    );
    assert!(matches!(sibling.plugin_id.as_str(), "plugin-b"));
    host.shutdown();
}

#[test]
fn child_denies_an_import_missing_from_exact_grants_before_execution() {
    let mut grants = permissions();
    grants.pop();
    let full_grants = permissions();
    let inspection =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &full_grants).unwrap();
    let load_fence = fence(LOAD_INVOCATION);
    let mut host = HostProcess::spawn();
    host.hello();
    host.send(
        &ParentFrame::Load {
            fence: load_fence.clone(),
            package_sha256: "3".repeat(64),
            component_sha256: sha256(RUST_COMPONENT),
            import_export_fingerprint: inspection.import_export_fingerprint,
            runtime_profile: RuntimeProfile::Rust,
            component_size: RUST_COMPONENT.len() as u64,
            permission_hash: canonical_permission_hash(&grants).unwrap(),
            grants,
            limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
        },
        RUST_COMPONENT,
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Failed {
                fence: load_fence,
                code: HostFailureCode::PermissionDenied,
            },
            Vec::new(),
        )
    );
    host.finish();
}
