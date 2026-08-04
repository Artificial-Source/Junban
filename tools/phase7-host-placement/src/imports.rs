//! Actual component import inspection for Wave 0 authority (not report constants).

use thiserror::Error;
use wasmparser::{Parser, Payload};

/// Frozen package/component byte ceiling from the Phase 7 context map.
pub const MAX_COMPONENT_BYTES: usize = 32 * 1024 * 1024;

/// Exact Rust wasm32-wasip2 baseline imports frozen by Wave 0 inspection.
pub const RUST_BASELINE_IMPORTS: &[&str] = &[
    "wasi:cli/environment@0.2.6",
    "wasi:cli/exit@0.2.6",
    "wasi:cli/stderr@0.2.6",
    "wasi:io/error@0.2.6",
    "wasi:io/streams@0.2.6",
];

#[derive(Debug, Error)]
pub enum ImportError {
    #[error("component exceeds {MAX_COMPONENT_BYTES} byte ceiling ({0} bytes)")]
    TooLarge(usize),
    #[error("wasm parse: {0}")]
    Parse(String),
}

/// Collect exact top-level component import names from component bytes.
pub fn inspect_component_imports(bytes: &[u8]) -> Result<Vec<String>, ImportError> {
    if bytes.len() > MAX_COMPONENT_BYTES {
        return Err(ImportError::TooLarge(bytes.len()));
    }
    let mut imports = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|e| ImportError::Parse(e.to_string()))?;
        if let Payload::ComponentImportSection(reader) = payload {
            for item in reader {
                let import = item.map_err(|e| ImportError::Parse(e.to_string()))?;
                imports.push(import.name.0.to_string());
            }
        }
    }
    imports.sort();
    imports.dedup();
    Ok(imports)
}

/// Compare inspected imports to an exact expected sorted set.
pub fn imports_match_exact(actual: &[String], expected: &[&str]) -> bool {
    let mut exp: Vec<&str> = expected.to_vec();
    exp.sort_unstable();
    exp.dedup();
    actual.len() == exp.len() && actual.iter().zip(exp.iter()).all(|(a, e)| a == e)
}

pub fn rust_baseline_ok(actual: &[String]) -> bool {
    imports_match_exact(actual, RUST_BASELINE_IMPORTS)
}

pub fn typescript_pure_ok(actual: &[String]) -> bool {
    actual.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_helper_detects_unexpected_and_missing() {
        let expected = ["a", "b"];
        assert!(imports_match_exact(&["a".into(), "b".into()], &expected));
        assert!(!imports_match_exact(&["a".into()], &expected));
        assert!(!imports_match_exact(
            &["a".into(), "b".into(), "c".into()],
            &expected
        ));
        assert!(!imports_match_exact(&["a".into(), "c".into()], &expected));
        assert!(typescript_pure_ok(&[]));
        assert!(!typescript_pure_ok(&["wasi:cli/exit@0.2.6".into()]));
        assert!(rust_baseline_ok(
            &RUST_BASELINE_IMPORTS
                .iter()
                .map(|s| (*s).to_string())
                .collect::<Vec<_>>()
        ));
    }

    #[test]
    fn rejects_oversized_buffer() {
        let huge = vec![0_u8; MAX_COMPONENT_BYTES + 1];
        assert!(matches!(
            inspect_component_imports(&huge),
            Err(ImportError::TooLarge(_))
        ));
    }
}
