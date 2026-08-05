use thiserror::Error;

/// Stable, bounded package-inspection failures. The variants deliberately do not
/// retain untrusted package, component, signature, key, or parser text.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum SdkError {
    #[error("{format} envelope is truncated")]
    Truncated { format: &'static str },
    #[error("{format} envelope has invalid magic")]
    Magic { format: &'static str },
    #[error("{field} length is outside the admitted bounds")]
    Length { field: &'static str },
    #[error("{format} envelope contains trailing bytes")]
    Trailing { format: &'static str },
    #[error("canonical JSON is invalid")]
    CanonicalJson,
    #[error("manifest field `{field}` is invalid")]
    Manifest { field: &'static str },
    #[error("duplicate or unsorted manifest field `{field}`")]
    Order { field: &'static str },
    #[error("package identity `{field}` does not agree with the envelope")]
    Identity { field: &'static str },
    #[error("strict signature verification failed")]
    Signature,
    #[error("signer trust policy is invalid")]
    TrustPolicy,
    #[error("package signer is not trusted")]
    UnknownSigner,
    #[error("package signer is revoked")]
    RevokedSigner,
    #[error("permission authority is invalid")]
    Permission,
    #[error("dependency graph is invalid: {kind}")]
    Graph { kind: &'static str },
    #[error("registry authority is invalid: {field}")]
    Registry { field: &'static str },
    #[error("component is malformed or invalid")]
    ComponentMalformed,
    #[error("component outer encoding is not the Component Model")]
    ComponentEncoding,
    #[error("component authority is invalid: {field}")]
    ComponentAuthority { field: &'static str },
    #[error("protocol frame is invalid: {field}")]
    Protocol { field: &'static str },
}

pub(crate) type Result<T> = std::result::Result<T, SdkError>;
