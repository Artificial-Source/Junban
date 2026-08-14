//! Auditable guest-to-host Component Model transfer authority.
//!
//! Wasmtime hostcall fuel is charged only while lifting guest-owned strings and
//! lists into host-owned values. It is deliberately independent of wasm
//! execution fuel and does not charge host-to-guest lowering.

use junban_plugin_sdk::HOST_CALLBACK_BODY_BYTES_MAX;

const KIB: usize = 1024;
const NAMED_VALUES_MAX: usize = 256;
const TYPED_LIST_ELEMENTS_MAX: usize = 64;
// Generated ComponentType::SIZE32 values are asserted below. The service call
// is the largest valid import shape: its private callback body can consume the
// full 4-MiB protocol authority, while 256 named values can each carry a
// 64-element list of 8-byte canonical descriptors.
const NAMED_VALUE_SIZE32: usize = 32;
const LIST_ELEMENT_SIZE32_MAX: usize = 8;
const MAX_IMPORT_STRUCTURAL_BYTES: usize =
    NAMED_VALUES_MAX * (NAMED_VALUE_SIZE32 + TYPED_LIST_ELEMENTS_MAX * LIST_ELEMENT_SIZE32_MAX);
const MAX_VALID_TRANSFER_BYTES: usize = HOST_CALLBACK_BODY_BYTES_MAX + MAX_IMPORT_STRUCTURAL_BYTES;

/// Headroom above the exact maximum valid protocol-plus-ABI shape.
pub const HOSTCALL_TRANSFER_MARGIN_BYTES: usize = 128 * KIB;

/// Per-component-call guest-to-host transfer fuel set on every Store.
///
/// `4_194_304 + 139_264 + 131_072 = 4_464_640` bytes. This replaces
/// Wasmtime 36.0.13's implicit 128-MiB default without changing any public WIT,
/// SDK protocol cap, guest memory limit, or wasm execution-fuel authority.
pub const HOSTCALL_TRANSFER_FUEL: usize = MAX_VALID_TRANSFER_BYTES + HOSTCALL_TRANSFER_MARGIN_BYTES;

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use wasmtime::{Engine, Store, component::ComponentType};

    use crate::bindings::junban::plugin::types as binding;

    use super::{
        HOSTCALL_TRANSFER_FUEL, HOSTCALL_TRANSFER_MARGIN_BYTES, LIST_ELEMENT_SIZE32_MAX,
        MAX_IMPORT_STRUCTURAL_BYTES, MAX_VALID_TRANSFER_BYTES, NAMED_VALUE_SIZE32,
    };
    use junban_plugin_sdk::{HOST_CALLBACK_BODY_BYTES_MAX, HOST_OUTCOME_BODY_BYTES_MAX};

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum Direction {
        ImportArgument,
        ExportResult,
    }

    #[derive(Clone, Copy, Debug)]
    struct Bound {
        direction: Direction,
        function: &'static str,
        bytes: usize,
    }

    // The worst compact canonical JSON element is a one-digit integer plus a
    // separator (two bytes) lifted to an eight-byte canonical list element.
    // Strings, bytes, variants, and records have no larger flat/JSON ratio.
    const MAX_EXPORT_TRANSFER_BYTES: usize = 4 * HOST_OUTCOME_BODY_BYTES_MAX;

    const BOUNDS: &[Bound] = &[
        Bound {
            direction: Direction::ImportArgument,
            function: "query-tasks",
            bytes: 10_139,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "query-projects",
            bytes: 264,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "query-tags",
            bytes: 264,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "get-settings",
            bytes: 0,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "get-kv",
            bytes: 8_704,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "list-kv",
            bytes: 264,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "wall-now",
            bytes: 0,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "monotonic-ms",
            bytes: 0,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "request",
            bytes: 1_329_664,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "log",
            bytes: 32 * 1024 + 384,
        },
        Bound {
            direction: Direction::ImportArgument,
            function: "call-service",
            bytes: MAX_VALID_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "activate",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "deactivate",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "invoke-command",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "handle-event",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "render-surface",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "handle-surface-action",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "validate-settings",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "resync",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
        Bound {
            direction: Direction::ExportResult,
            function: "call-service",
            bytes: MAX_EXPORT_TRANSFER_BYTES,
        },
    ];

    #[test]
    fn all_imports_and_exports_fit_with_explicit_margin() {
        let imports = BOUNDS
            .iter()
            .filter(|bound| bound.direction == Direction::ImportArgument)
            .count();
        let exports = BOUNDS
            .iter()
            .filter(|bound| bound.direction == Direction::ExportResult)
            .count();
        assert_eq!((imports, exports), (11, 9));
        assert_eq!(
            BOUNDS
                .iter()
                .map(|bound| bound.function)
                .collect::<BTreeSet<_>>()
                .len(),
            19,
            "call-service is intentionally present in both directions",
        );

        assert_eq!(MAX_IMPORT_STRUCTURAL_BYTES, 139_264);
        assert_eq!(MAX_VALID_TRANSFER_BYTES, 4_333_568);
        assert_eq!(HOSTCALL_TRANSFER_MARGIN_BYTES, 131_072);
        assert_eq!(HOSTCALL_TRANSFER_FUEL, 4_464_640);
        assert_eq!(
            BOUNDS.iter().map(|bound| bound.bytes).max(),
            Some(MAX_VALID_TRANSFER_BYTES),
        );
        assert!(
            BOUNDS
                .iter()
                .all(|bound| bound.bytes <= HOSTCALL_TRANSFER_FUEL)
        );
    }

    #[test]
    fn wasmtime_default_is_not_an_acceptable_implicit_authority() {
        let engine = Engine::default();
        let mut store = Store::new(&engine, ());
        assert!(store.hostcall_fuel() > HOSTCALL_TRANSFER_FUEL);
        store.set_hostcall_fuel(HOSTCALL_TRANSFER_FUEL);
        assert_eq!(store.hostcall_fuel(), HOSTCALL_TRANSFER_FUEL);
    }

    #[test]
    fn hand_calculated_flat_bytes_match_generated_abi() {
        assert_eq!(<String as ComponentType>::SIZE32, LIST_ELEMENT_SIZE32_MAX);
        assert_eq!(
            <binding::NamedValue as ComponentType>::SIZE32,
            NAMED_VALUE_SIZE32
        );
        assert_eq!(<binding::HttpHeader as ComponentType>::SIZE32, 16);
        assert_eq!(<binding::LogField as ComponentType>::SIZE32, 24);
        assert_eq!(<binding::KvOperation as ComponentType>::SIZE32, 20);
        let export_maximum = BOUNDS
            .iter()
            .filter(|bound| bound.direction == Direction::ExportResult)
            .map(|bound| bound.bytes)
            .max()
            .unwrap();
        assert_eq!(export_maximum, 4 * HOST_OUTCOME_BODY_BYTES_MAX);
        assert!(export_maximum < MAX_VALID_TRANSFER_BYTES);
        assert_eq!(HOST_CALLBACK_BODY_BYTES_MAX, 4 * 1024 * 1024);
    }
}
