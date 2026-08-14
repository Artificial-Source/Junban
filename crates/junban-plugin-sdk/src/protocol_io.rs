//! Strict synchronous I/O for the private parent↔selected-child protocol.
//!
//! A protocol message is one canonical u32be-length-prefixed JSON header
//! followed by the exact raw body authorized by that header. Reads validate a
//! bounded header before allocating its body. Clean EOF is recognized only
//! before any byte of the next header length has been read.

use std::io::{Read, Write};

use crate::{
    ChildFrame, HOST_FRAME_BYTES_MAX, ParentFrame, SdkError, child_body_len, decode_child_frame,
    decode_parent_frame, encode_child_frame, encode_parent_frame, parent_body_len,
    validate_child_body, validate_parent_body,
};

/// One direction-specific parent-to-child protocol message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParentMessage {
    pub frame: ParentFrame,
    pub body: Vec<u8>,
}

impl ParentMessage {
    #[must_use]
    pub fn new(frame: ParentFrame, body: Vec<u8>) -> Self {
        Self { frame, body }
    }

    #[must_use]
    pub fn into_parts(self) -> (ParentFrame, Vec<u8>) {
        (self.frame, self.body)
    }
}

/// One direction-specific child-to-parent protocol message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChildMessage {
    pub frame: ChildFrame,
    pub body: Vec<u8>,
}

impl ChildMessage {
    #[must_use]
    pub fn new(frame: ChildFrame, body: Vec<u8>) -> Self {
        Self { frame, body }
    }

    #[must_use]
    pub fn into_parts(self) -> (ChildFrame, Vec<u8>) {
        (self.frame, self.body)
    }
}

/// Bounded, redacted failures at the private protocol stream boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProtocolIoError {
    Input,
    Output,
}

impl std::fmt::Display for ProtocolIoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Input => "protocol input rejected",
            Self::Output => "protocol output failed",
        })
    }
}

impl std::error::Error for ProtocolIoError {}

/// Read and validate one parent header without reading or allocating its body.
/// This permits the child to apply session/state authority before accepting the
/// already bounded body declared by the header.
pub fn read_parent_frame(reader: &mut impl Read) -> Result<Option<ParentFrame>, ProtocolIoError> {
    read_frame(reader, decode_parent_frame)
}

/// Read and validate the exact body authorized by a previously read parent
/// header. The header's body ceiling is checked before allocation.
pub fn read_parent_body(
    reader: &mut impl Read,
    frame: &ParentFrame,
) -> Result<Vec<u8>, ProtocolIoError> {
    read_body(reader, frame, parent_body_len, validate_parent_body)
}

/// Read one complete parent-to-child message. `None` means clean pre-header
/// EOF; every partial header, partial body, or malformed message is an error.
pub fn read_parent_message(
    reader: &mut impl Read,
) -> Result<Option<ParentMessage>, ProtocolIoError> {
    let Some(frame) = read_parent_frame(reader)? else {
        return Ok(None);
    };
    let body = read_parent_body(reader, &frame)?;
    Ok(Some(ParentMessage::new(frame, body)))
}

/// Write one complete validated parent-to-child message and flush it.
pub fn write_parent_message(
    writer: &mut impl Write,
    frame: &ParentFrame,
    body: &[u8],
) -> Result<(), ProtocolIoError> {
    write_message(
        writer,
        frame,
        body,
        validate_parent_body,
        encode_parent_frame,
    )
}

/// Read and validate one child header without reading or allocating its body.
pub fn read_child_frame(reader: &mut impl Read) -> Result<Option<ChildFrame>, ProtocolIoError> {
    read_frame(reader, decode_child_frame)
}

/// Read and validate the exact body authorized by a previously read child
/// header. The header's body ceiling is checked before allocation.
pub fn read_child_body(
    reader: &mut impl Read,
    frame: &ChildFrame,
) -> Result<Vec<u8>, ProtocolIoError> {
    read_body(reader, frame, child_body_len, validate_child_body)
}

/// Read one complete child-to-parent message. `None` means clean pre-header
/// EOF; every partial header, partial body, or malformed message is an error.
pub fn read_child_message(reader: &mut impl Read) -> Result<Option<ChildMessage>, ProtocolIoError> {
    let Some(frame) = read_child_frame(reader)? else {
        return Ok(None);
    };
    let body = read_child_body(reader, &frame)?;
    Ok(Some(ChildMessage::new(frame, body)))
}

/// Write one complete validated child-to-parent message and flush it.
pub fn write_child_message(
    writer: &mut impl Write,
    frame: &ChildFrame,
    body: &[u8],
) -> Result<(), ProtocolIoError> {
    write_message(writer, frame, body, validate_child_body, encode_child_frame)
}

fn read_frame<T>(
    reader: &mut impl Read,
    decode: fn(&[u8]) -> Result<T, SdkError>,
) -> Result<Option<T>, ProtocolIoError> {
    let Some(prefix) = read_prefix(reader)? else {
        return Ok(None);
    };
    let header_len =
        usize::try_from(u32::from_be_bytes(prefix)).map_err(|_| ProtocolIoError::Input)?;
    if header_len == 0 || header_len > HOST_FRAME_BYTES_MAX {
        return Err(ProtocolIoError::Input);
    }
    let encoded_len = 4_usize
        .checked_add(header_len)
        .ok_or(ProtocolIoError::Input)?;
    let mut encoded = vec![0; encoded_len];
    encoded[..4].copy_from_slice(&prefix);
    read_exact_input(reader, &mut encoded[4..])?;
    decode(&encoded)
        .map(Some)
        .map_err(|_| ProtocolIoError::Input)
}

fn read_body<T>(
    reader: &mut impl Read,
    frame: &T,
    body_len: fn(&T) -> Result<usize, SdkError>,
    validate: fn(&T, &[u8]) -> Result<(), SdkError>,
) -> Result<Vec<u8>, ProtocolIoError> {
    let body_len = body_len(frame).map_err(|_| ProtocolIoError::Input)?;
    let mut body = vec![0; body_len];
    read_exact_input(reader, &mut body)?;
    validate(frame, &body).map_err(|_| ProtocolIoError::Input)?;
    Ok(body)
}

fn write_message<T>(
    writer: &mut impl Write,
    frame: &T,
    body: &[u8],
    validate: fn(&T, &[u8]) -> Result<(), SdkError>,
    encode: fn(&T) -> Result<Vec<u8>, SdkError>,
) -> Result<(), ProtocolIoError> {
    validate(frame, body).map_err(|_| ProtocolIoError::Output)?;
    let encoded = encode(frame).map_err(|_| ProtocolIoError::Output)?;
    writer
        .write_all(&encoded)
        .map_err(|_| ProtocolIoError::Output)?;
    writer
        .write_all(body)
        .map_err(|_| ProtocolIoError::Output)?;
    writer.flush().map_err(|_| ProtocolIoError::Output)
}

fn read_prefix(reader: &mut impl Read) -> Result<Option<[u8; 4]>, ProtocolIoError> {
    let mut prefix = [0; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => return Err(ProtocolIoError::Input),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(ProtocolIoError::Input),
        }
    }
    read_exact_input(reader, &mut prefix[1..])?;
    Ok(Some(prefix))
}

fn read_exact_input(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), ProtocolIoError> {
    reader.read_exact(bytes).map_err(|_| ProtocolIoError::Input)
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use serde::Serialize;

    use super::*;
    use crate::{
        AuthorityFence, CallbackFence, HOST_CALLBACK_BODY_BYTES_MAX, HOST_COMPONENT_BODY_BYTES_MAX,
        HOST_JUNBAN_VERSION, HOST_OUTCOME_BODY_BYTES_MAX, HOST_PROTOCOL_NAME,
        HOST_PROTOCOL_VERSION, HOST_REQUEST_BODY_BYTES_MAX, HostCallReply, HostCallRequest,
        InvocationKind, InvocationOutcome, InvocationRequest, RuntimeLimits, RuntimeProfile,
        canonical_permission_hash, private_body_types::WitResult,
    };

    const SESSION: &str = "00000000-0000-4000-8000-000000000001";
    const INVOCATION: &str = "00000000-0000-4000-8000-000000000002";

    fn fence() -> AuthorityFence {
        AuthorityFence {
            plugin_id: "test-plugin".into(),
            package_generation: 7,
            activation_epoch: 9,
            host_session_id: SESSION.into(),
            invocation_id: INVOCATION.into(),
        }
    }

    fn callback() -> CallbackFence {
        CallbackFence {
            plugin_id: "test-plugin".into(),
            package_generation: 7,
            activation_epoch: 9,
            host_session_id: SESSION.into(),
            invocation_id: INVOCATION.into(),
            callback_id: 1,
        }
    }

    fn parent_hello() -> ParentFrame {
        ParentFrame::Hello {
            protocol_name: HOST_PROTOCOL_NAME.into(),
            protocol_version: HOST_PROTOCOL_VERSION,
            junban_version: HOST_JUNBAN_VERSION.into(),
            host_session_id: SESSION.into(),
        }
    }

    fn child_hello() -> ChildFrame {
        ChildFrame::Hello {
            protocol_name: HOST_PROTOCOL_NAME.into(),
            protocol_version: HOST_PROTOCOL_VERSION,
            junban_version: HOST_JUNBAN_VERSION.into(),
            host_session_id: SESSION.into(),
        }
    }

    fn parent_invoke() -> (ParentFrame, Vec<u8>) {
        InvocationRequest::activate(None)
            .into_parent_message(fence(), canonical_permission_hash(&[]).unwrap())
            .unwrap()
            .into_parts()
    }

    fn child_outcome() -> (ChildFrame, Vec<u8>) {
        InvocationOutcome::Activate(WitResult::Ok(()))
            .into_child_message(fence())
            .unwrap()
            .into_parts()
    }

    fn unchecked_frame(value: &impl Serialize) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        wire_payload(&payload)
    }

    fn wire_payload(payload: &[u8]) -> Vec<u8> {
        let mut bytes = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
        bytes.extend_from_slice(payload);
        bytes
    }

    fn parent_wire(frame: &ParentFrame, body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_parent_message(&mut bytes, frame, body).unwrap();
        bytes
    }

    fn child_wire(frame: &ChildFrame, body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_child_message(&mut bytes, frame, body).unwrap();
        bytes
    }

    #[test]
    fn parent_message_has_an_exact_bidirectional_byte_golden() {
        let (frame, body) = parent_invoke();
        let expected_header = concat!(
            "{\"type\":\"invoke\",\"fence\":{\"plugin_id\":\"test-plugin\",",
            "\"package_generation\":7,\"activation_epoch\":9,",
            "\"host_session_id\":\"00000000-0000-4000-8000-000000000001\",",
            "\"invocation_id\":\"00000000-0000-4000-8000-000000000002\"},",
            "\"kind\":\"activate\",\"mode\":\"lifecycle\",",
            "\"permission_hash\":\"996047b66c237637f56cce747bba80b7bee9658f969808644eab322306fa6d6c\",",
            "\"request_sha256\":\"7ff4622b19bb0c110396c79d00294e20274aa77ccb9505147a2b46d22798b165\",",
            "\"request_size\":58}"
        );
        let expected_body = br#"{"tag":"activate","val":{"entry-id":null,"argument":null}}"#;
        let mut expected = u32::try_from(expected_header.len())
            .unwrap()
            .to_be_bytes()
            .to_vec();
        expected.extend_from_slice(expected_header.as_bytes());
        expected.extend_from_slice(expected_body);

        assert_eq!(body, expected_body);
        assert_eq!(parent_wire(&frame, &body), expected);
        assert_eq!(
            read_parent_message(&mut Cursor::new(&expected)).unwrap(),
            Some(ParentMessage::new(frame, body))
        );
    }

    #[test]
    fn child_message_has_an_exact_bidirectional_byte_golden() {
        let (frame, body) = child_outcome();
        let expected_header = concat!(
            "{\"type\":\"outcome\",\"fence\":{\"plugin_id\":\"test-plugin\",",
            "\"package_generation\":7,\"activation_epoch\":9,",
            "\"host_session_id\":\"00000000-0000-4000-8000-000000000001\",",
            "\"invocation_id\":\"00000000-0000-4000-8000-000000000002\"},",
            "\"kind\":\"activate\",",
            "\"outcome_sha256\":\"286c4496db0cae5f84aedcaedc9a54eaa04d9145780ee1cc80950230b8069767\",",
            "\"outcome_size\":48}"
        );
        let expected_body = br#"{"tag":"activate","val":{"tag":"ok","val":null}}"#;
        let mut expected = u32::try_from(expected_header.len())
            .unwrap()
            .to_be_bytes()
            .to_vec();
        expected.extend_from_slice(expected_header.as_bytes());
        expected.extend_from_slice(expected_body);

        assert_eq!(body, expected_body);
        assert_eq!(child_wire(&frame, &body), expected);
        assert_eq!(
            read_child_message(&mut Cursor::new(&expected)).unwrap(),
            Some(ChildMessage::new(frame, body))
        );
    }

    #[test]
    fn clean_eof_is_distinct_from_every_partial_prefix_and_header() {
        assert_eq!(read_parent_message(&mut Cursor::new([])).unwrap(), None);
        assert_eq!(read_child_message(&mut Cursor::new([])).unwrap(), None);

        for bytes in [&[0_u8][..], &[0, 0][..], &[0, 0, 0][..]] {
            assert_eq!(
                read_parent_message(&mut Cursor::new(bytes)),
                Err(ProtocolIoError::Input)
            );
            assert_eq!(
                read_child_message(&mut Cursor::new(bytes)),
                Err(ProtocolIoError::Input)
            );
        }

        let parent = parent_wire(&parent_hello(), &[]);
        let child = child_wire(&child_hello(), &[]);
        for truncated in [&parent[..4], &parent[..parent.len() - 1]] {
            assert_eq!(
                read_parent_message(&mut Cursor::new(truncated)),
                Err(ProtocolIoError::Input)
            );
        }
        for truncated in [&child[..4], &child[..child.len() - 1]] {
            assert_eq!(
                read_child_message(&mut Cursor::new(truncated)),
                Err(ProtocolIoError::Input)
            );
        }
    }

    #[test]
    fn zero_and_oversized_header_lengths_fail_before_payload_reads() {
        for prefix in [
            0_u32.to_be_bytes(),
            u32::try_from(HOST_FRAME_BYTES_MAX + 1)
                .unwrap()
                .to_be_bytes(),
        ] {
            let mut parent = Cursor::new(prefix);
            assert_eq!(
                read_parent_message(&mut parent),
                Err(ProtocolIoError::Input)
            );
            assert_eq!(parent.position(), 4);

            let mut child = Cursor::new(prefix);
            assert_eq!(read_child_message(&mut child), Err(ProtocolIoError::Input));
            assert_eq!(child.position(), 4);
        }
    }

    #[test]
    fn noncanonical_unknown_and_duplicate_headers_fail_in_both_directions() {
        let canonical = serde_json::to_vec(&parent_hello()).unwrap();
        let mut noncanonical = Vec::with_capacity(canonical.len() + 1);
        noncanonical.push(b' ');
        noncanonical.extend_from_slice(&canonical);
        let unknown = format!(
            "{{\"type\":\"hello\",\"protocol_name\":\"{HOST_PROTOCOL_NAME}\",\"protocol_version\":{HOST_PROTOCOL_VERSION},\"junban_version\":\"{HOST_JUNBAN_VERSION}\",\"host_session_id\":\"{SESSION}\",\"token\":\"forbidden\"}}"
        );
        let duplicate = format!(
            "{{\"type\":\"hello\",\"protocol_name\":\"{HOST_PROTOCOL_NAME}\",\"protocol_version\":{HOST_PROTOCOL_VERSION},\"junban_version\":\"{HOST_JUNBAN_VERSION}\",\"host_session_id\":\"{SESSION}\",\"host_session_id\":\"{SESSION}\"}}"
        );

        for payload in [noncanonical, unknown.into_bytes(), duplicate.into_bytes()] {
            let bytes = wire_payload(&payload);
            assert_eq!(
                read_parent_message(&mut Cursor::new(&bytes)),
                Err(ProtocolIoError::Input)
            );
            assert_eq!(
                read_child_message(&mut Cursor::new(&bytes)),
                Err(ProtocolIoError::Input)
            );
        }
    }

    #[test]
    fn parent_load_invoke_and_callback_bodies_are_exact_and_typed() {
        let component = b"component";
        let load = ParentFrame::Load {
            fence: fence(),
            package_sha256: "1".repeat(64),
            component_sha256: "6985ca1f4daa5a584a28eae043a239cb96689af1337ea13afb63e00c2bf512fa"
                .into(),
            import_export_fingerprint: "2".repeat(64),
            runtime_profile: RuntimeProfile::Typescript,
            component_size: component.len() as u64,
            grants: Vec::new(),
            permission_hash: canonical_permission_hash(&[]).unwrap(),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
        };
        assert_eq!(
            read_parent_message(&mut Cursor::new(parent_wire(&load, component))).unwrap(),
            Some(ParentMessage::new(load, component.to_vec()))
        );

        let (invoke, body) = parent_invoke();
        let mut wrong_kind = invoke.clone();
        if let ParentFrame::Invoke { kind, .. } = &mut wrong_kind {
            *kind = InvocationKind::Deactivate;
        }
        let mut bytes = unchecked_frame(&wrong_kind);
        bytes.extend_from_slice(&body);
        assert_eq!(
            read_parent_message(&mut Cursor::new(bytes)),
            Err(ProtocolIoError::Input)
        );

        let reply = HostCallReply::MonotonicMs(42)
            .into_parent_message(callback())
            .unwrap();
        let (mut reply_frame, reply_body) = reply.into_parts();
        if let ParentFrame::CapabilityReply { kind, .. } = &mut reply_frame {
            *kind = crate::HostCallKind::WallNow;
        }
        let mut bytes = unchecked_frame(&reply_frame);
        bytes.extend_from_slice(&reply_body);
        assert_eq!(
            read_parent_message(&mut Cursor::new(bytes)),
            Err(ProtocolIoError::Input)
        );
    }

    #[test]
    fn child_callback_and_outcome_bodies_are_exact_and_typed() {
        let request = HostCallRequest::MonotonicMs(())
            .into_child_message(callback())
            .unwrap();
        let (mut request_frame, request_body) = request.into_parts();
        let valid = child_wire(&request_frame, &request_body);
        assert_eq!(
            read_child_message(&mut Cursor::new(valid)).unwrap(),
            Some(ChildMessage::new(
                request_frame.clone(),
                request_body.clone()
            ))
        );
        if let ChildFrame::CapabilityRequest { kind, .. } = &mut request_frame {
            *kind = crate::HostCallKind::WallNow;
        }
        let mut bytes = unchecked_frame(&request_frame);
        bytes.extend_from_slice(&request_body);
        assert_eq!(
            read_child_message(&mut Cursor::new(bytes)),
            Err(ProtocolIoError::Input)
        );

        let (mut outcome, outcome_body) = child_outcome();
        if let ChildFrame::Outcome { kind, .. } = &mut outcome {
            *kind = InvocationKind::Deactivate;
        }
        let mut bytes = unchecked_frame(&outcome);
        bytes.extend_from_slice(&outcome_body);
        assert_eq!(
            read_child_message(&mut Cursor::new(bytes)),
            Err(ProtocolIoError::Input)
        );
    }

    #[test]
    fn partial_wrong_length_and_wrong_hash_bodies_fail_closed() {
        let (invoke, body) = parent_invoke();
        let mut partial_parent = unchecked_frame(&invoke);
        partial_parent.extend_from_slice(&body[..body.len() - 1]);
        assert_eq!(
            read_parent_message(&mut Cursor::new(partial_parent)),
            Err(ProtocolIoError::Input)
        );
        let mut wrong_parent_hash = invoke;
        if let ParentFrame::Invoke { request_sha256, .. } = &mut wrong_parent_hash {
            *request_sha256 = "0".repeat(64);
        }
        let mut bytes = unchecked_frame(&wrong_parent_hash);
        bytes.extend_from_slice(&body);
        assert_eq!(
            read_parent_message(&mut Cursor::new(bytes)),
            Err(ProtocolIoError::Input)
        );

        let (outcome, body) = child_outcome();
        let mut partial_child = unchecked_frame(&outcome);
        partial_child.extend_from_slice(&body[..body.len() - 1]);
        assert_eq!(
            read_child_message(&mut Cursor::new(partial_child)),
            Err(ProtocolIoError::Input)
        );
        let mut wrong_child_hash = outcome;
        if let ChildFrame::Outcome { outcome_sha256, .. } = &mut wrong_child_hash {
            *outcome_sha256 = "0".repeat(64);
        }
        let mut bytes = unchecked_frame(&wrong_child_hash);
        bytes.extend_from_slice(&body);
        assert_eq!(
            read_child_message(&mut Cursor::new(bytes)),
            Err(ProtocolIoError::Input)
        );
    }

    #[test]
    fn bodyless_and_trailing_body_mismatches_are_rejected() {
        assert_eq!(
            write_parent_message(&mut Vec::new(), &parent_hello(), b"unexpected"),
            Err(ProtocolIoError::Output)
        );
        assert_eq!(
            write_child_message(&mut Vec::new(), &child_hello(), b"unexpected"),
            Err(ProtocolIoError::Output)
        );

        let mut parent = parent_wire(&parent_hello(), &[]);
        parent.push(1);
        let mut parent = Cursor::new(parent);
        assert!(read_parent_message(&mut parent).unwrap().is_some());
        assert_eq!(
            read_parent_message(&mut parent),
            Err(ProtocolIoError::Input)
        );

        let mut child = child_wire(&child_hello(), &[]);
        child.push(1);
        let mut child = Cursor::new(child);
        assert!(read_child_message(&mut child).unwrap().is_some());
        assert_eq!(read_child_message(&mut child), Err(ProtocolIoError::Input));
    }

    #[test]
    fn every_body_ceiling_is_rejected_from_the_header_before_body_read() {
        let oversized_load = ParentFrame::Load {
            fence: fence(),
            package_sha256: "1".repeat(64),
            component_sha256: "2".repeat(64),
            import_export_fingerprint: "3".repeat(64),
            runtime_profile: RuntimeProfile::Typescript,
            component_size: u64::try_from(HOST_COMPONENT_BODY_BYTES_MAX + 1).unwrap(),
            grants: Vec::new(),
            permission_hash: canonical_permission_hash(&[]).unwrap(),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
        };
        let oversized_invoke = ParentFrame::Invoke {
            fence: fence(),
            kind: InvocationKind::Activate,
            mode: InvocationKind::Activate.mode(),
            permission_hash: canonical_permission_hash(&[]).unwrap(),
            request_sha256: "1".repeat(64),
            request_size: u32::try_from(HOST_REQUEST_BODY_BYTES_MAX + 1).unwrap(),
        };
        let oversized_reply = ParentFrame::CapabilityReply {
            callback: callback(),
            kind: crate::HostCallKind::GetSettings,
            result: crate::CapabilityReplyKind::Success,
            response_sha256: "1".repeat(64),
            response_size: u32::try_from(HOST_CALLBACK_BODY_BYTES_MAX + 1).unwrap(),
        };
        for frame in [oversized_load, oversized_invoke, oversized_reply] {
            let bytes = unchecked_frame(&frame);
            let header_end = bytes.len() as u64;
            let mut reader = Cursor::new(bytes);
            assert_eq!(read_parent_frame(&mut reader), Err(ProtocolIoError::Input));
            assert_eq!(reader.position(), header_end);
        }

        let oversized_callback = ChildFrame::CapabilityRequest {
            callback: callback(),
            kind: crate::HostCallKind::GetSettings,
            request_sha256: "1".repeat(64),
            request_size: u32::try_from(HOST_CALLBACK_BODY_BYTES_MAX + 1).unwrap(),
        };
        let oversized_outcome = ChildFrame::Outcome {
            fence: fence(),
            kind: InvocationKind::Activate,
            outcome_sha256: "1".repeat(64),
            outcome_size: u32::try_from(HOST_OUTCOME_BODY_BYTES_MAX + 1).unwrap(),
        };
        for frame in [oversized_callback, oversized_outcome] {
            let bytes = unchecked_frame(&frame);
            let header_end = bytes.len() as u64;
            let mut reader = Cursor::new(bytes);
            assert_eq!(read_child_frame(&mut reader), Err(ProtocolIoError::Input));
            assert_eq!(reader.position(), header_end);
        }
    }

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("sensitive transport detail"))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stream_errors_are_directional_bounded_and_redacted() {
        assert_eq!(
            ProtocolIoError::Input.to_string(),
            "protocol input rejected"
        );
        assert_eq!(
            ProtocolIoError::Output.to_string(),
            "protocol output failed"
        );
        assert_eq!(
            write_parent_message(&mut FailingWriter, &parent_hello(), &[]),
            Err(ProtocolIoError::Output)
        );
        assert_eq!(
            write_child_message(&mut FailingWriter, &child_hello(), &[]),
            Err(ProtocolIoError::Output)
        );
    }
}
