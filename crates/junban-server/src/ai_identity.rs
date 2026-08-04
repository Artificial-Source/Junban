//! Deterministic server-owned identities for one idempotent AI response.

use junban_domain::{AiMessageId, AiRunId, AiTurnId, OperationId};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const ID_DOMAIN: &[u8] = b"junban.ai.response.v1\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiResponseIdentity {
    pub source_operation_id: OperationId,
    pub turn_id: AiTurnId,
    pub run_id: AiRunId,
    pub user_message_id: AiMessageId,
    pub assistant_message_id: AiMessageId,
    pub user_message_operation_id: OperationId,
    pub assistant_start_operation_id: OperationId,
    pub running_run_operation_id: OperationId,
    pub finish_operation_id: OperationId,
}

impl AiResponseIdentity {
    #[must_use]
    pub fn derive(operation_id: OperationId) -> Self {
        Self {
            source_operation_id: operation_id,
            turn_id: derive(operation_id, b"turn", AiTurnId::parse),
            run_id: derive(operation_id, b"run", AiRunId::parse),
            user_message_id: derive(operation_id, b"message.user", AiMessageId::parse),
            assistant_message_id: derive(operation_id, b"message.assistant", AiMessageId::parse),
            user_message_operation_id: derive(
                operation_id,
                b"operation.message.user",
                OperationId::parse,
            ),
            assistant_start_operation_id: derive(
                operation_id,
                b"operation.message.assistant.start",
                OperationId::parse,
            ),
            running_run_operation_id: derive(
                operation_id,
                b"operation.run.running",
                OperationId::parse,
            ),
            finish_operation_id: derive(
                operation_id,
                b"operation.response.finish",
                OperationId::parse,
            ),
        }
    }

    #[must_use]
    pub fn round(self, round: u8) -> AiRoundIdentity {
        let label = |suffix: &str| format!("round.{round}.{suffix}");
        AiRoundIdentity {
            assistant_tool_update_operation_id: derive(
                self.source_operation_id,
                label("operation.message.assistant.tool").as_bytes(),
                OperationId::parse,
            ),
            approval_id: derive(
                self.source_operation_id,
                label("approval").as_bytes(),
                junban_domain::AiApprovalId::parse,
            ),
            propose_operation_id: derive(
                self.source_operation_id,
                label("operation.approval.propose").as_bytes(),
                OperationId::parse,
            ),
            expire_operation_id: derive(
                self.source_operation_id,
                label("operation.response.expire").as_bytes(),
                OperationId::parse,
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiRoundIdentity {
    pub assistant_tool_update_operation_id: OperationId,
    pub approval_id: junban_domain::AiApprovalId,
    pub propose_operation_id: OperationId,
    pub expire_operation_id: OperationId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiHttpDecisionIdentity {
    pub receipt_operation_id: OperationId,
}

impl AiHttpDecisionIdentity {
    #[must_use]
    pub fn derive(operation_id: OperationId) -> Self {
        Self {
            receipt_operation_id: derive(
                operation_id,
                b"approval.http.decision.receipt",
                OperationId::parse,
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiApprovalDecisionIdentity {
    pub approved_operation_id: OperationId,
    pub rejected_operation_id: OperationId,
    pub consume_operation_id: OperationId,
    pub finish_operation_id: OperationId,
}

impl AiApprovalDecisionIdentity {
    #[must_use]
    pub fn derive(approval_id: junban_domain::AiApprovalId) -> Self {
        let source = OperationId::parse(&approval_id.to_string())
            .expect("approval UUID is a valid operation UUID derivation source");
        Self {
            approved_operation_id: derive(
                source,
                b"approval.operation.approved",
                OperationId::parse,
            ),
            rejected_operation_id: derive(
                source,
                b"approval.operation.rejected",
                OperationId::parse,
            ),
            consume_operation_id: derive(source, b"approval.operation.consume", OperationId::parse),
            finish_operation_id: derive(source, b"approval.operation.finish", OperationId::parse),
        }
    }
}

fn derive<T>(
    operation_id: OperationId,
    label: &[u8],
    parse: impl FnOnce(&str) -> Result<T, junban_domain::ValidationError>,
) -> T {
    let mut hasher = Sha256::new();
    hasher.update(ID_DOMAIN);
    hasher.update(operation_id.as_uuid().as_bytes());
    hasher.update([0]);
    hasher.update(label);
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // RFC 9562 variant plus UUID version 8 (application-defined SHA-256 layout).
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let encoded = Uuid::from_bytes(bytes).to_string();
    parse(&encoded).expect("derived UUID must parse through the domain authority")
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn stable_identity_vector_and_uuid_bits() {
        let source = OperationId::parse("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let identity = AiResponseIdentity::derive(source);
        assert_eq!(
            identity.turn_id.to_string(),
            "0801fdce-dabf-80ac-8a4a-72dfa07ba928"
        );
        assert_eq!(
            identity.run_id.to_string(),
            "b603fae8-94e3-8f8e-b482-732b445e55df"
        );
        assert_eq!(
            identity.user_message_id.to_string(),
            "be14cda1-4f9a-8d4d-b1e7-21f05419a703"
        );
        assert_eq!(
            identity.assistant_message_id.to_string(),
            "9f727295-6b61-84ed-81c9-733ed2943a4c"
        );
        assert_eq!(
            identity.assistant_start_operation_id.to_string(),
            "ff43f4d0-17ac-895e-b876-f62739fa1303"
        );
        assert_eq!(
            identity.finish_operation_id.to_string(),
            "e6f86940-9742-82ca-b377-3c20714e0aa8"
        );
        for value in all_values(identity) {
            let uuid = Uuid::parse_str(&value).unwrap();
            assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
            assert_eq!(uuid.get_version_num(), 8);
        }
    }

    #[test]
    fn labels_are_domain_separated_without_collisions() {
        let mut seen = HashSet::new();
        for source in 1..=1_024_u128 {
            let operation_id = OperationId::parse(&Uuid::from_u128(source).to_string()).unwrap();
            for value in all_values(AiResponseIdentity::derive(operation_id)) {
                assert!(seen.insert(value), "derived identity collision");
            }
        }
        assert_eq!(seen.len(), 1_024 * 8);
    }

    #[test]
    fn round_and_decision_labels_are_stable_distinct_version_eight_ids() {
        let source = OperationId::parse("00112233-4455-6677-8899-aabbccddeeff").unwrap();
        let response = AiResponseIdentity::derive(source);
        let mut seen = all_values(response).into_iter().collect::<HashSet<_>>();
        for round_number in 1..=8 {
            let round = response.round(round_number);
            for value in [
                round.assistant_tool_update_operation_id.to_string(),
                round.approval_id.to_string(),
                round.propose_operation_id.to_string(),
                round.expire_operation_id.to_string(),
            ] {
                assert!(seen.insert(value.clone()), "round identity collision");
                let uuid = Uuid::parse_str(&value).unwrap();
                assert_eq!(uuid.get_variant(), uuid::Variant::RFC4122);
                assert_eq!(uuid.get_version_num(), 8);
            }
            let decision = AiApprovalDecisionIdentity::derive(round.approval_id);
            for value in [
                decision.approved_operation_id.to_string(),
                decision.rejected_operation_id.to_string(),
                decision.consume_operation_id.to_string(),
                decision.finish_operation_id.to_string(),
            ] {
                assert!(seen.insert(value), "decision identity collision");
            }
        }
        let http = AiHttpDecisionIdentity::derive(source);
        assert!(seen.insert(http.receipt_operation_id.to_string()));
    }

    fn all_values(identity: AiResponseIdentity) -> Vec<String> {
        vec![
            identity.turn_id.to_string(),
            identity.run_id.to_string(),
            identity.user_message_id.to_string(),
            identity.assistant_message_id.to_string(),
            identity.user_message_operation_id.to_string(),
            identity.assistant_start_operation_id.to_string(),
            identity.running_run_operation_id.to_string(),
            identity.finish_operation_id.to_string(),
        ]
    }
}
