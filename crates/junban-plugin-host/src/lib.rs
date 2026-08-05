#![forbid(unsafe_code)]

mod bindings;
mod generated_body_adapters;

use std::io::{self, Read, Write};

use junban_plugin_sdk::{
    AuthorityFence, ChildFrame, HOST_FRAME_BYTES_MAX, HOST_PROTOCOL_NAME, HOST_PROTOCOL_VERSION,
    HostFailureCode, ParentFrame, decode_parent_frame, encode_child_frame, parent_body_len,
    validate_child_body, validate_parent_body,
};
use wasmtime::{
    Config, Engine, InstanceAllocationStrategy, ProfilingStrategy, component::Component,
};

/// One strict parent frame and its exact, hash-bound raw body.
#[derive(Debug, Eq, PartialEq)]
pub struct ParentMessage {
    pub frame: ParentFrame,
    pub body: Vec<u8>,
}

/// Bounded protocol/runtime errors. Untrusted parser, guest, path, and body
/// material is deliberately not retained or formatted.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostError {
    Input,
    Output,
    Engine,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Input => "protocol input rejected",
            Self::Output => "protocol output failed",
            Self::Engine => "runtime initialization failed",
        })
    }
}

impl std::error::Error for HostError {}

/// Read canonical u32be-length-prefixed JSON and its exact raw body. Length
/// ceilings are checked before either attacker-declared allocation.
pub fn read_parent_message(reader: &mut impl Read) -> Result<Option<ParentMessage>, HostError> {
    let Some(prefix) = read_prefix(reader)? else {
        return Ok(None);
    };
    let header_len = u32::from_be_bytes(prefix) as usize;
    if header_len == 0 || header_len > HOST_FRAME_BYTES_MAX {
        return Err(HostError::Input);
    }

    let encoded_len = 4_usize.checked_add(header_len).ok_or(HostError::Input)?;
    let mut encoded = vec![0_u8; encoded_len];
    encoded[..4].copy_from_slice(&prefix);
    read_exact_input(reader, &mut encoded[4..])?;
    let frame = decode_parent_frame(&encoded).map_err(|_| HostError::Input)?;
    let body_len = parent_body_len(&frame).map_err(|_| HostError::Input)?;
    let mut body = vec![0_u8; body_len];
    read_exact_input(reader, &mut body)?;
    validate_parent_body(&frame, &body).map_err(|_| HostError::Input)?;
    Ok(Some(ParentMessage { frame, body }))
}

/// Write only one SDK-canonical child frame and exact raw body.
pub fn write_child_message(
    writer: &mut impl Write,
    frame: &ChildFrame,
    body: &[u8],
) -> Result<(), HostError> {
    validate_child_body(frame, body).map_err(|_| HostError::Output)?;
    let encoded = encode_child_frame(frame).map_err(|_| HostError::Output)?;
    writer.write_all(&encoded).map_err(|_| HostError::Output)?;
    writer.write_all(body).map_err(|_| HostError::Output)?;
    writer.flush().map_err(|_| HostError::Output)
}

fn read_prefix(reader: &mut impl Read) -> Result<Option<[u8; 4]>, HostError> {
    let mut prefix = [0_u8; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => return Err(HostError::Input),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(HostError::Input),
        }
    }
    read_exact_input(reader, &mut prefix[1..])?;
    Ok(Some(prefix))
}

fn read_exact_input(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), HostError> {
    reader.read_exact(bytes).map_err(|_| HostError::Input)
}

struct LoadedComponent {
    fence: AuthorityFence,
    permission_hash: String,
    _component: Component,
}

/// One process-local runtime owner. It compiles at most one exact component and
/// intentionally does not instantiate or link guest imports in Slice 2A.
pub struct ChildHost {
    engine: Engine,
    host_session_id: Option<String>,
    load_attempted: bool,
    loaded: Option<LoadedComponent>,
}

impl ChildHost {
    pub fn new() -> Result<Self, HostError> {
        let mut config = Config::new();
        config
            .wasm_component_model(true)
            .wasm_component_model_gc(false)
            .async_support(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .allocation_strategy(InstanceAllocationStrategy::OnDemand)
            .profiler(ProfilingStrategy::None);
        let engine = Engine::new(&config).map_err(|_| HostError::Engine)?;
        Ok(Self {
            engine,
            host_session_id: None,
            load_attempted: false,
            loaded: None,
        })
    }

    fn handle(&mut self, message: ParentMessage) -> Result<(Option<ChildFrame>, bool), HostError> {
        match message.frame {
            ParentFrame::Hello {
                protocol_name,
                protocol_version,
                host_session_id,
            } if self.host_session_id.is_none() => {
                debug_assert_eq!(protocol_name, HOST_PROTOCOL_NAME);
                debug_assert_eq!(protocol_version, HOST_PROTOCOL_VERSION);
                self.host_session_id = Some(host_session_id.clone());
                Ok((
                    Some(ChildFrame::Hello {
                        protocol_name,
                        protocol_version,
                        host_session_id,
                    }),
                    false,
                ))
            }
            ParentFrame::Load {
                fence,
                component_sha256: _,
                import_export_fingerprint,
                package_sha256: _,
                runtime_profile: _,
                component_size: _,
                grants: _,
                permission_hash,
                limits: _,
            } => {
                if !self.session_matches(&fence) || self.load_attempted {
                    return Ok((Some(failed(fence, HostFailureCode::StaleAuthority)), false));
                }
                self.load_attempted = true;
                match Component::new(&self.engine, &message.body) {
                    Ok(component) => {
                        self.loaded = Some(LoadedComponent {
                            fence: fence.clone(),
                            permission_hash,
                            _component: component,
                        });
                        Ok((
                            Some(ChildFrame::Loaded {
                                fence,
                                import_export_fingerprint,
                            }),
                            false,
                        ))
                    }
                    Err(_) => Ok((
                        Some(failed(fence, HostFailureCode::InvalidComponent)),
                        false,
                    )),
                }
            }
            ParentFrame::Invoke {
                fence,
                permission_hash,
                ..
            } => {
                let code = if self.loaded_matches(&fence, Some(&permission_hash)) {
                    HostFailureCode::Unavailable
                } else {
                    HostFailureCode::StaleAuthority
                };
                Ok((Some(failed(fence, code)), false))
            }
            ParentFrame::Cancel { fence } | ParentFrame::Unload { fence } => {
                let code = if self.loaded_matches(&fence, None) {
                    HostFailureCode::Unavailable
                } else {
                    HostFailureCode::StaleAuthority
                };
                Ok((Some(failed(fence, code)), false))
            }
            ParentFrame::CapabilityReply { callback, .. } => {
                let fence = callback.authority();
                let code = if self.loaded_matches(&fence, None) {
                    HostFailureCode::Unavailable
                } else {
                    HostFailureCode::StaleAuthority
                };
                Ok((Some(failed(fence, code)), false))
            }
            ParentFrame::Shutdown { host_session_id }
                if self.host_session_id.as_deref() == Some(host_session_id.as_str()) =>
            {
                self.loaded = None;
                Ok((Some(ChildFrame::ShutdownComplete { host_session_id }), true))
            }
            ParentFrame::Hello { .. } | ParentFrame::Shutdown { .. } => Err(HostError::Input),
        }
    }

    fn session_matches(&self, fence: &AuthorityFence) -> bool {
        self.host_session_id.as_deref() == Some(fence.host_session_id.as_str())
    }

    fn loaded_matches(&self, fence: &AuthorityFence, permission_hash: Option<&str>) -> bool {
        self.loaded.as_ref().is_some_and(|loaded| {
            self.session_matches(fence)
                && loaded.fence.same_activation(fence)
                && permission_hash.is_none_or(|hash| hash == loaded.permission_hash)
        })
    }
}

fn failed(fence: AuthorityFence, code: HostFailureCode) -> ChildFrame {
    ChildFrame::Failed { fence, code }
}

/// Run one bounded child session to shutdown or clean EOF.
pub fn run_child(reader: &mut impl Read, writer: &mut impl Write) -> Result<(), HostError> {
    let mut host = ChildHost::new()?;
    while let Some(message) = read_parent_message(reader)? {
        let (response, stop) = host.handle(message)?;
        if let Some(response) = response {
            write_child_message(writer, &response, &[])?;
        }
        if stop {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_plugin_sdk::{
        InvocationRequest, RuntimeLimits, RuntimeProfile, SdkError, canonical_permission_hash,
        encode_parent_frame, private_body_types as neutral,
    };

    use crate::bindings::junban::plugin::types as binding;

    const SESSION: &str = "00000000-0000-4000-8000-000000000001";
    const INVOCATION: &str = "00000000-0000-4000-8000-000000000002";

    fn fence() -> AuthorityFence {
        AuthorityFence {
            plugin_id: "test-plugin".into(),
            package_generation: 1,
            activation_epoch: 2,
            host_session_id: SESSION.into(),
            invocation_id: INVOCATION.into(),
        }
    }

    fn tiny_component() -> Vec<u8> {
        let mut component = Vec::with_capacity(8);
        component.extend_from_slice(b"\0asm");
        component.extend_from_slice(&[0x0d, 0x00, 0x01, 0x00]);
        component
    }

    fn encode(frame: &ParentFrame, body: &[u8]) -> Vec<u8> {
        let mut bytes = encode_parent_frame(frame).unwrap();
        bytes.extend_from_slice(body);
        bytes
    }

    fn hello() -> ParentFrame {
        ParentFrame::Hello {
            protocol_name: HOST_PROTOCOL_NAME.into(),
            protocol_version: HOST_PROTOCOL_VERSION,
            host_session_id: SESSION.into(),
        }
    }

    fn load(component: &[u8]) -> ParentFrame {
        ParentFrame::Load {
            fence: fence(),
            package_sha256: "1".repeat(64),
            component_sha256: sha256_hex(component),
            import_export_fingerprint: "2".repeat(64),
            runtime_profile: RuntimeProfile::Typescript,
            component_size: component.len() as u64,
            grants: Vec::new(),
            permission_hash: canonical_permission_hash(&[]).unwrap(),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        use std::fmt::Write as _;

        let digest = Sha256::digest(bytes);
        let mut encoded = String::with_capacity(64);
        for byte in digest {
            write!(&mut encoded, "{byte:02x}").unwrap();
        }
        encoded
    }

    fn assert_binding_round_trip<N, B>(value: N)
    where
        N: Clone + std::fmt::Debug + Eq + Into<B>,
        B: TryInto<N, Error = SdkError>,
    {
        let binding: B = value.clone().into();
        let actual = binding.try_into().unwrap();
        assert_eq!(actual, value);
    }

    #[test]
    fn generated_neutral_and_wasmtime_values_round_trip_and_bound_bytes() {
        assert_binding_round_trip::<_, binding::InvocationContext>(neutral::InvocationContext {
            plugin_id: "plugin".into(),
            package_generation: 7,
            activation_epoch: 9,
            host_session_id: "session".into(),
            invocation_id: "invocation".into(),
            entry_id: Some("entry".into()),
        });
        assert_binding_round_trip::<_, binding::TaskQuery>(neutral::TaskQuery {
            task_id: None,
            project_id: Some("project".into()),
            section_id: None,
            parent_id: None,
            tag_ids: vec!["tag".into()],
            statuses: vec![neutral::TaskStatus::Pending],
            priorities: vec![neutral::Priority::P1],
            due_from: None,
            due_before: Some("2030-01-02".into()),
            search: None,
            cursor: Some("cursor".into()),
            limit: 10,
        });
        assert_binding_round_trip::<_, binding::StringChange>(neutral::StringChange::Unchanged(()));
        assert_binding_round_trip::<_, binding::DomainMutation>(
            neutral::DomainMutation::CompleteTask("task".into()),
        );
        assert_binding_round_trip::<_, binding::PluginOutcome>(neutral::PluginOutcome {
            effect: Some(neutral::PluginEffect::KvPatch(neutral::KvPatch {
                operations: vec![neutral::KvOperation::Set(neutral::KvSet {
                    key: "key".into(),
                    value: neutral::ByteList::new(vec![0xfb, 0xff]).unwrap(),
                })],
            })),
        });
        assert_binding_round_trip::<_, binding::HttpRequest>(neutral::HttpRequest {
            method: neutral::HttpMethod::Post,
            origin: "https://example.com".into(),
            path_and_query: "/path".into(),
            headers: vec![neutral::HttpHeader {
                name: "accept".into(),
                value: "application/json".into(),
            }],
            body: neutral::ByteList::new(vec![0xfb, 0xff]).unwrap(),
        });
        assert_binding_round_trip::<_, binding::ResyncPage>(neutral::ResyncPage::Finalize(
            neutral::FinalizeResync {
                session_id: "session".into(),
            },
        ));

        let oversized = binding::HttpRequest {
            method: binding::HttpMethod::Post,
            origin: "https://example.com".into(),
            path_and_query: "/path".into(),
            headers: Vec::new(),
            body: vec![0; neutral::BYTE_LIST_BYTES_MAX + 1],
        };
        assert!(matches!(
            neutral::HttpRequest::try_from(oversized),
            Err(SdkError::Protocol {
                field: "byte list length"
            })
        ));
    }

    #[test]
    fn codec_rejects_noncanonical_duplicate_unknown_truncated_and_oversized_headers() {
        let canonical = encode(&hello(), &[]);
        assert!(
            read_parent_message(&mut canonical.as_slice())
                .unwrap()
                .is_some()
        );

        for payload in [
            br#"{ "type":"hello","protocol_name":"junban-plugin-host-v1","protocol_version":1,"host_session_id":"00000000-0000-4000-8000-000000000001"}"#.as_slice(),
            br#"{"type":"hello","protocol_name":"junban-plugin-host-v1","protocol_version":1,"protocol_version":1,"host_session_id":"00000000-0000-4000-8000-000000000001"}"#.as_slice(),
            br#"{"type":"hello","protocol_name":"junban-plugin-host-v1","protocol_version":1,"host_session_id":"00000000-0000-4000-8000-000000000001","unknown":true}"#.as_slice(),
            br#"{"type":"unknown"}"#.as_slice(),
        ] {
            let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(payload);
            assert_eq!(read_parent_message(&mut bytes.as_slice()), Err(HostError::Input));
        }

        assert_eq!(
            read_parent_message(&mut canonical[..3].as_ref()),
            Err(HostError::Input)
        );
        assert_eq!(
            read_parent_message(&mut ((HOST_FRAME_BYTES_MAX as u32) + 1).to_be_bytes().as_ref()),
            Err(HostError::Input)
        );

        let component = tiny_component();
        let encoded_load = encode_parent_frame(&load(&component)).unwrap();
        let payload = std::str::from_utf8(&encoded_load[4..])
            .unwrap()
            .replace("\"component_size\":8", "\"component_size\":33554433");
        assert!(payload.contains("\"component_size\":33554433"));
        let mut oversized_body = (payload.len() as u32).to_be_bytes().to_vec();
        oversized_body.extend_from_slice(payload.as_bytes());
        assert_eq!(
            read_parent_message(&mut oversized_body.as_slice()),
            Err(HostError::Input)
        );

        let mut trailing = canonical;
        trailing.push(0);
        let mut trailing = trailing.as_slice();
        assert!(read_parent_message(&mut trailing).unwrap().is_some());
        assert_eq!(read_parent_message(&mut trailing), Err(HostError::Input));
    }

    #[test]
    fn codec_rejects_bad_protocol_version_body_hash_length_and_truncation() {
        let payload = br#"{"type":"hello","protocol_name":"not-junban","protocol_version":1,"host_session_id":"00000000-0000-4000-8000-000000000001"}"#.as_slice();
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(payload);
        assert_eq!(
            read_parent_message(&mut bytes.as_slice()),
            Err(HostError::Input)
        );

        let wrong_version_payload = br#"{"type":"hello","protocol_name":"junban-plugin-host-v1","protocol_version":2,"host_session_id":"00000000-0000-4000-8000-000000000001"}"#;
        let mut wrong_version = (wrong_version_payload.len() as u32).to_be_bytes().to_vec();
        wrong_version.extend_from_slice(wrong_version_payload);
        assert_eq!(
            read_parent_message(&mut wrong_version.as_slice()),
            Err(HostError::Input)
        );

        let component = tiny_component();
        let frame = load(&component);
        let short = encode(&frame, &component[..component.len() - 1]);
        assert_eq!(
            read_parent_message(&mut short.as_slice()),
            Err(HostError::Input)
        );
        let mut wrong_hash = frame.clone();
        if let ParentFrame::Load {
            component_sha256, ..
        } = &mut wrong_hash
        {
            *component_sha256 = "0".repeat(64);
        }
        assert_eq!(
            read_parent_message(&mut encode(&wrong_hash, &component).as_slice()),
            Err(HostError::Input)
        );
    }

    #[test]
    fn valid_component_compiles_once_and_unsupported_calls_are_fenced() {
        let component = tiny_component();
        let mut input = encode(&hello(), &[]);
        input.extend_from_slice(&encode(&load(&component), &component));
        input.extend_from_slice(&encode(&load(&component), &component));
        let invoke_fence = AuthorityFence {
            invocation_id: "00000000-0000-4000-8000-000000000003".into(),
            ..fence()
        };
        let request_message = InvocationRequest::activate(None)
            .into_parent_message(invoke_fence, canonical_permission_hash(&[]).unwrap())
            .unwrap();
        let (invoke, request) = request_message.into_parts();
        input.extend_from_slice(&encode(&invoke, &request));
        input.extend_from_slice(&encode(
            &ParentFrame::Shutdown {
                host_session_id: SESSION.into(),
            },
            &[],
        ));

        let mut output = Vec::new();
        run_child(&mut input.as_slice(), &mut output).unwrap();
        assert!(!output.is_empty());
    }

    #[test]
    fn clean_eof_and_shutdown_are_bounded_and_panic_free() {
        let mut output = Vec::new();
        run_child(&mut io::empty(), &mut output).unwrap();
        assert!(output.is_empty());

        let mut input = encode(&hello(), &[]);
        input.extend_from_slice(&encode(
            &ParentFrame::Shutdown {
                host_session_id: SESSION.into(),
            },
            &[],
        ));
        run_child(&mut input.as_slice(), &mut output).unwrap();
        assert!(!output.is_empty());

        for size in 0..512 {
            let hostile = vec![0xa5; size];
            let _ = read_parent_message(&mut hostile.as_slice());
        }
    }
}
