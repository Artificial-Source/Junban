//! Runtime-local authority for one exact plugin invocation delivery.
//!
//! Delivery authority is deliberately not serializable or persisted. SQLite
//! stores only the final request hash derived from this authority.

use junban_domain::OperationId;
use junban_plugin_sdk::{
    InvocationKind, PluginId, SdkError, Sha256Digest, decode_invocation_request,
};

use crate::{
    CommittedEvent, PluginHookKind, PluginResyncSession, RepositoryError,
    plugin_resync_request_hash,
};

const DELIVERY_AUTHORITY_DOMAIN: &[u8] = b"junban.plugin.delivery-authority.v1\0";
const INVOCATION_REQUEST_DOMAIN: &[u8] = b"junban.plugin.invocation-request.v2\0";
const RETAINED_EVENT_PAYLOAD_DOMAIN: &[u8] = b"junban.plugin.retained-event-payload.v1\0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginDeliveryMode {
    StartingResync,
    StartingCatchUp,
    Active,
}

impl PluginDeliveryMode {
    const fn tag(self) -> u8 {
        match self {
            Self::StartingResync => 0x00,
            Self::StartingCatchUp => 0x01,
            Self::Active => 0x02,
        }
    }

    const fn admits(self, hook: PluginHookKind) -> bool {
        matches!(
            (self, hook),
            (Self::StartingResync, PluginHookKind::Resync)
                | (Self::StartingCatchUp, PluginHookKind::HandleEvent)
                | (
                    Self::Active,
                    PluginHookKind::InvokeCommand
                        | PluginHookKind::HandleEvent
                        | PluginHookKind::HandleSurfaceAction
                )
        )
    }
}

/// Exact runtime/session generation and payload bound to one dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginDeliveryAuthority {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: OperationId,
    pub invocation_id: OperationId,
    pub payload_sha256: Sha256Digest,
    pub mode: PluginDeliveryMode,
}

impl PluginDeliveryAuthority {
    fn validate(&self) -> Result<(), RepositoryError> {
        if self.package_generation == 0 || self.activation_epoch == 0 {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }

    /// Hash the frozen v1 delivery-authority framing.
    pub fn digest(&self) -> Result<Sha256Digest, RepositoryError> {
        self.validate()?;
        let mut material = Vec::with_capacity(256);
        material.extend_from_slice(DELIVERY_AUTHORITY_DOMAIN);
        put_u64_text(&mut material, self.plugin_id.as_str())?;
        material.extend_from_slice(&self.package_generation.to_be_bytes());
        material.extend_from_slice(&self.activation_epoch.to_be_bytes());
        put_u64_text(&mut material, &self.host_session_id.to_string())?;
        put_u64_text(&mut material, &self.invocation_id.to_string())?;
        material.extend_from_slice(&digest_bytes(&self.payload_sha256));
        material.push(self.mode.tag());
        Ok(Sha256Digest::of(&material))
    }
}

/// Durable identity and request hash against which storage verifies a delivery.
#[derive(Clone, Copy, Debug)]
pub struct PluginInvocationDeliveryCheck<'a> {
    pub operation_id: OperationId,
    pub plugin_id: &'a PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub hook: PluginHookKind,
    pub persisted_entry_id: &'a PluginId,
    pub stored_request_sha256: &'a Sha256Digest,
}

/// Authority and final hash carried unchanged through every durable stage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginInvocationDelivery {
    pub authority: PluginDeliveryAuthority,
    pub persisted_entry_id: PluginId,
    pub request_sha256: Sha256Digest,
}

impl PluginInvocationDelivery {
    pub fn new(
        authority: PluginDeliveryAuthority,
        hook: PluginHookKind,
        persisted_entry_id: PluginId,
    ) -> Result<Self, RepositoryError> {
        if !authority.mode.admits(hook) {
            return Err(RepositoryError::Conflict);
        }
        let request_sha256 =
            plugin_invocation_request_hash(hook, &persisted_entry_id, &authority.digest()?)?;
        Ok(Self {
            authority,
            persisted_entry_id,
            request_sha256,
        })
    }

    pub fn verify(&self, check: PluginInvocationDeliveryCheck<'_>) -> Result<(), RepositoryError> {
        if self.authority.invocation_id != check.operation_id
            || &self.authority.plugin_id != check.plugin_id
            || self.authority.package_generation != check.package_generation
            || self.authority.activation_epoch != check.activation_epoch
            || !self.authority.mode.admits(check.hook)
            || &self.persisted_entry_id != check.persisted_entry_id
            || &self.request_sha256 != check.stored_request_sha256
            || plugin_invocation_request_hash(
                check.hook,
                check.persisted_entry_id,
                &self.authority.digest()?,
            )? != self.request_sha256
        {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }
}

/// Decode an exact closed private invocation body and hash its canonical bytes.
pub fn plugin_canonical_invocation_body_hash(
    kind: InvocationKind,
    expected_entry_id: Option<&str>,
    body: &[u8],
) -> Result<Sha256Digest, SdkError> {
    let request = decode_invocation_request(kind, body)?;
    if request.entry_id() != expected_entry_id {
        return Err(SdkError::Protocol {
            field: "body entry id",
        });
    }
    Ok(Sha256Digest::of(body))
}

/// Canonical content identity of one typed retained event envelope.
pub fn plugin_committed_event_content_hash(
    event: &CommittedEvent,
) -> Result<Sha256Digest, RepositoryError> {
    let bytes =
        serde_json::to_vec(event).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(Sha256Digest::of(&bytes))
}

/// Bind one retained event's canonical content and exact private event body.
pub fn plugin_retained_event_payload_hash(
    event_content_sha256: &Sha256Digest,
    expected_entry_id: &str,
    private_body: &[u8],
) -> Result<Sha256Digest, RepositoryError> {
    plugin_canonical_invocation_body_hash(
        InvocationKind::HandleEvent,
        Some(expected_entry_id),
        private_body,
    )
    .map_err(|_| RepositoryError::Conflict)?;
    let body_len = u32::try_from(private_body.len()).map_err(|_| RepositoryError::Conflict)?;
    let mut material =
        Vec::with_capacity(RETAINED_EVENT_PAYLOAD_DOMAIN.len() + 32 + 4 + private_body.len());
    material.extend_from_slice(RETAINED_EVENT_PAYLOAD_DOMAIN);
    material.extend_from_slice(&digest_bytes(event_content_sha256));
    material.extend_from_slice(&body_len.to_be_bytes());
    material.extend_from_slice(private_body);
    Ok(Sha256Digest::of(&material))
}

/// Existing resync-session request identity used as the delivery payload digest.
#[must_use]
pub fn plugin_resync_payload_hash(session: &PluginResyncSession) -> Sha256Digest {
    plugin_resync_request_hash(session)
}

/// Hash the exact final v2 invocation request framing persisted in schema v7.
pub fn plugin_invocation_request_hash(
    hook: PluginHookKind,
    persisted_entry_id: &PluginId,
    delivery_authority_sha256: &Sha256Digest,
) -> Result<Sha256Digest, RepositoryError> {
    let entry_len =
        u64::try_from(persisted_entry_id.as_str().len()).map_err(|_| RepositoryError::Conflict)?;
    let mut material = Vec::with_capacity(
        INVOCATION_REQUEST_DOMAIN.len() + 1 + 8 + persisted_entry_id.as_str().len() + 32,
    );
    material.extend_from_slice(INVOCATION_REQUEST_DOMAIN);
    material.push(match hook {
        PluginHookKind::InvokeCommand => 0x00,
        PluginHookKind::HandleEvent => 0x01,
        PluginHookKind::HandleSurfaceAction => 0x02,
        PluginHookKind::Resync => 0x03,
    });
    material.extend_from_slice(&entry_len.to_be_bytes());
    material.extend_from_slice(persisted_entry_id.as_str().as_bytes());
    material.extend_from_slice(&digest_bytes(delivery_authority_sha256));
    Ok(Sha256Digest::of(&material))
}

fn put_u64_text(material: &mut Vec<u8>, value: &str) -> Result<(), RepositoryError> {
    let len = u64::try_from(value.len()).map_err(|_| RepositoryError::Conflict)?;
    material.extend_from_slice(&len.to_be_bytes());
    material.extend_from_slice(value.as_bytes());
    Ok(())
}

fn digest_bytes(digest: &Sha256Digest) -> [u8; 32] {
    fn nibble(byte: u8) -> u8 {
        match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => unreachable!("Sha256Digest guarantees canonical lowercase hex"),
        }
    }

    let encoded = digest.as_str().as_bytes();
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (nibble(encoded[index * 2]) << 4) | nibble(encoded[index * 2 + 1]);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use junban_domain::OperationId;
    use junban_plugin_sdk::{InvocationKind, PluginId, Sha256Digest};

    use super::*;
    use crate::{AffectedIds, EventType, ResyncScope};

    fn operation(value: &str) -> OperationId {
        OperationId::parse(value).unwrap()
    }

    fn authority(mode: PluginDeliveryMode) -> PluginDeliveryAuthority {
        PluginDeliveryAuthority {
            plugin_id: PluginId::parse("delivery-test").unwrap(),
            package_generation: 7,
            activation_epoch: 11,
            host_session_id: operation("70000000-0000-7000-8000-000000000001"),
            invocation_id: operation("70000000-0000-7000-8000-000000000002"),
            payload_sha256: Sha256Digest::of(b"payload"),
            mode,
        }
    }

    #[test]
    fn canonical_private_bodies_cover_lifecycle_event_resync_and_service() {
        let bodies = [
            (
                InvocationKind::Activate,
                None,
                br#"{"tag":"activate","val":{"entry-id":null,"argument":null}}"#.as_slice(),
            ),
            (
                InvocationKind::HandleEvent,
                Some("event"),
                br#"{"tag":"handle-event","val":{"entry-id":"event","argument":{"event-epoch":"epoch","revision":7,"kind":"task-deleted","subject":{"tag":"deleted-task","val":"task-1"}}}}"#,
            ),
            (
                InvocationKind::Resync,
                Some("resync"),
                br#"{"tag":"resync","val":{"entry-id":"resync","argument":{"tag":"finalize","val":{"session-id":"session"}}}}"#,
            ),
            (
                InvocationKind::CallService,
                Some("service"),
                br#"{"tag":"call-service","val":{"entry-id":"service","argument":{"plugin-id":"dependency","service-id":"service","values":[]}}}"#,
            ),
        ];
        for (kind, expected_entry_id, body) in bodies {
            assert_eq!(
                plugin_canonical_invocation_body_hash(kind, expected_entry_id, body).unwrap(),
                Sha256Digest::of(body)
            );
        }
        let noncanonical = br#"{ "tag":"activate","val":{"entry-id":null,"argument":null}}"#;
        assert!(
            plugin_canonical_invocation_body_hash(InvocationKind::Activate, None, noncanonical)
                .is_err()
        );
        assert!(
            plugin_canonical_invocation_body_hash(
                InvocationKind::HandleEvent,
                Some("changed"),
                bodies[1].2,
            )
            .is_err()
        );
        assert!(
            plugin_canonical_invocation_body_hash(
                InvocationKind::Resync,
                Some("event"),
                bodies[1].2,
            )
            .is_err()
        );
    }

    #[test]
    fn delivery_payload_authority_and_final_request_hash_have_frozen_goldens() {
        let delivery = PluginInvocationDelivery::new(
            authority(PluginDeliveryMode::Active),
            PluginHookKind::InvokeCommand,
            PluginId::parse("run").unwrap(),
        )
        .unwrap();
        assert_eq!(
            delivery.authority.digest().unwrap().as_str(),
            "5d9dc033b5d7560300c54f63eea7407a06a84d9e677501c33762810e1f054da2"
        );
        assert_eq!(
            delivery.request_sha256.as_str(),
            "33f7022a26faea482cadc653de3727ace1d258c8eca930e20ca42791ba098be6"
        );

        let body = br#"{"tag":"handle-event","val":{"entry-id":"event","argument":{"event-epoch":"epoch","revision":7,"kind":"task-deleted","subject":{"tag":"deleted-task","val":"task-1"}}}}"#;
        let event = CommittedEvent {
            revision: 7,
            operation_id: operation("70000000-0000-7000-8000-000000000003"),
            event_type: EventType::new("task.deleted"),
            occurred_at: Timestamp::constant(1_800_000_000, 0),
            primary: None,
            snapshot: None,
            affected: AffectedIds::default(),
            resync: ResyncScope::TASKS,
        };
        let event_hash = plugin_committed_event_content_hash(&event).unwrap();
        assert_eq!(
            event_hash.as_str(),
            "42498920871534ff96a0e4b84fc43b8e30d2dc1d174588319dd34dded2271bfa"
        );
        assert_eq!(
            plugin_retained_event_payload_hash(&event_hash, "event", body)
                .unwrap()
                .as_str(),
            "48b0801f8275904836db68931060d52f17590dc72d557f93b8bde3636ea201be"
        );
    }

    #[test]
    fn every_delivery_input_and_mode_mismatch_fails_closed() {
        let operation_id = operation("70000000-0000-7000-8000-000000000002");
        let plugin_id = PluginId::parse("delivery-test").unwrap();
        let entry_id = PluginId::parse("run").unwrap();
        let delivery = PluginInvocationDelivery::new(
            authority(PluginDeliveryMode::Active),
            PluginHookKind::InvokeCommand,
            entry_id.clone(),
        )
        .unwrap();
        let check = |hook| PluginInvocationDeliveryCheck {
            operation_id,
            plugin_id: &plugin_id,
            package_generation: 7,
            activation_epoch: 11,
            hook,
            persisted_entry_id: &entry_id,
            stored_request_sha256: &delivery.request_sha256,
        };
        delivery
            .verify(check(PluginHookKind::InvokeCommand))
            .unwrap();

        let mutations: [fn(&mut PluginInvocationDelivery); 9] = [
            |value| value.authority.plugin_id = PluginId::parse("changed").unwrap(),
            |value| value.authority.package_generation += 1,
            |value| value.authority.activation_epoch += 1,
            |value| value.authority.host_session_id = OperationId::new(),
            |value| value.authority.invocation_id = OperationId::new(),
            |value| value.authority.payload_sha256 = Sha256Digest::of(b"changed"),
            |value| value.authority.mode = PluginDeliveryMode::StartingCatchUp,
            |value| value.persisted_entry_id = PluginId::parse("changed").unwrap(),
            |value| value.request_sha256 = Sha256Digest::of(b"changed"),
        ];
        for mutate in mutations {
            let mut changed = delivery.clone();
            mutate(&mut changed);
            assert!(
                changed
                    .verify(check(PluginHookKind::InvokeCommand))
                    .is_err()
            );
        }
        assert!(
            delivery
                .verify(check(PluginHookKind::HandleSurfaceAction))
                .is_err()
        );
        assert!(
            PluginInvocationDelivery::new(
                authority(PluginDeliveryMode::StartingResync),
                PluginHookKind::HandleEvent,
                PluginId::parse("event").unwrap(),
            )
            .is_err()
        );
        assert!(
            PluginInvocationDelivery::new(
                authority(PluginDeliveryMode::StartingCatchUp),
                PluginHookKind::Resync,
                PluginId::parse("resync").unwrap(),
            )
            .is_err()
        );
    }
}
