//! Credential wrappers that never expose raw secret material via Debug/Serialize.

use std::fmt;

/// Opaque credential material. Debug is redacted; serialization is intentionally absent.
#[derive(Clone)]
pub struct SecretString(String);

impl SecretString {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Borrow the raw secret for request construction only.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

impl PartialEq for SecretString {
    fn eq(&self, other: &Self) -> bool {
        // Constant-time equality is not required for local credential handles;
        // never surface the bytes through formatting paths.
        self.0 == other.0
    }
}

impl Eq for SecretString {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_leaks_secret_bytes() {
        let secret = SecretString::new("sk-test-not-for-logs");
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("sk-test"));
        assert!(rendered.contains("REDACTED"));
    }
}
