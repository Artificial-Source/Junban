use crate::{error::SdkError, package::VerifiedPackage, util::decode_hex_32};

pub const SIGNER_TRUST_RECORDS_MAX: usize = 4_096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignerTrust {
    BundledRegistry,
    LocalExplicit,
    Revoked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SignerTrustRecord<'a> {
    pub key_id: &'a str,
    pub trust: SignerTrust,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VerifiedSignerAuthority {
    pub trust: SignerTrust,
}

/// Resolve the exact verified SHA-256 key identity through a sorted caller-owned
/// trust snapshot. Package signature and key-id verification have already
/// succeeded. Duplicate, unsorted, or malformed policy entries fail closed.
pub fn verify_signer_authority(
    package: &VerifiedPackage<'_>,
    records: &[SignerTrustRecord<'_>],
) -> Result<VerifiedSignerAuthority, SdkError> {
    if records.len() > SIGNER_TRUST_RECORDS_MAX {
        return Err(SdkError::TrustPolicy);
    }
    let mut previous = None;
    let mut matched = None;
    for record in records {
        decode_hex_32(record.key_id, "signer trust key_id").map_err(|_| SdkError::TrustPolicy)?;
        if previous.is_some_and(|value| value >= record.key_id) {
            return Err(SdkError::TrustPolicy);
        }
        if record.key_id == package.identities.key_id {
            matched = Some(record.trust);
        }
        previous = Some(record.key_id);
    }
    match matched {
        Some(trust @ (SignerTrust::BundledRegistry | SignerTrust::LocalExplicit)) => {
            Ok(VerifiedSignerAuthority { trust })
        }
        Some(SignerTrust::Revoked) => Err(SdkError::RevokedSigner),
        None => Err(SdkError::UnknownSigner),
    }
}
