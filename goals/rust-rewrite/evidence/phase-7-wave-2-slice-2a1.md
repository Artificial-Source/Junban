# Phase 7 Wave 2 Slice 2A.1 — generated typed private body authority

Date: 2026-08-05
Status: accepted — focused API-contract recheck fixed `P7-API-001` and authorized Slice 2B guest execution
Parent: [`phase-7-wave-2-plan.md`](phase-7-wave-2-plan.md)
Finding: `P7-API-001` fixed

## Delivered boundary

- `junban-plugin-sdk` now checks in `private_body_types.rs`, a pure Rust serde representation generated deterministically from the one public `wit/plugin.wit`. It covers every named WIT type in declaration order plus generated guest/host function argument and result aliases. There is no handwritten mirror of the WIT model.
- The required-feature `junban-plugin-body-codegen` binary uses the already pinned `wit-parser`, freezes the exact WIT package identity and SHA-256, regenerates both neutral types and child adapters, and supports nonmutating byte comparison with `--check`. CI runs that check. Ordinary SDK/server code performs no build-time or runtime generation and gains no Wasmtime, wit-bindgen runtime, or Node dependency.
- Generated record field names and order match WIT exactly. Options must be present as a value or `null`; enums use their exact lowercase kebab-case names; variants and WIT results use closed `{"tag", "val"}` objects and materialize unit as `"val":null`; integers use exact JSON integer tokens. WIT `list<u8>` values use a bounded `ByteList` newtype with strict canonical unpadded base64url.
- One bounded canonical decoder is authoritative: reject an over-limit body before serde allocation, parse the expected closed type, reserialize through the bounded writer, and require byte equality. Unknown, duplicate, omitted/defaulted, reordered, whitespace-alternate, wrong-kind/branch, numeric-alternate, and noncanonical byte encodings fail as stable SDK protocol errors.
- Exhaustive typed envelopes map all nine invocation arguments/results and all eleven host calls. Invocation bodies own `entry-id` plus the exact WIT argument or unit; `InvocationRequest::context` constructs the exact WIT context from the parent-owned authority fence plus that entry ID. Guest `err(plugin-error)` stays an `Outcome`; trap/runtime failure remains `Failed`. `ChildFrame::Outcome` now carries `InvocationKind` for standalone validation.
- Host request/reply mappings cover task/project/tag/settings/KV/list/clock/HTTP/log/service exactly. Fallible host calls carry their WIT `host-error` or `http-error`; clock and log cannot construct an error and raw error headers are rejected. Cancellation is the sole empty callback reply. Component load bytes remain raw and hash-bound.
- Public typed message constructors derive kind, mode/result branch, canonical bytes, size, and SHA-256 as one inseparable pair. No caller-selected method-plus-opaque-bytes constructor was added. Public typed decoders and generated per-function aliases are the neutral compile boundary the child can match in Slice 2B.
- The same WIT generator emits exhaustive conversions for all 104 nominal neutral/Wasmtime record, enum, and variant pairs. Neutral-to-binding conversion is infallible; binding-to-neutral conversion is fallible so byte lists regain the private body bound. The child compiles Wasmtime's WIT binding types and representative nested/unit/option/list/byte adapters round-trip in tests. This adds no linker construction, Store, component instantiation, export call, or guest execution.
- Existing SDK and child fixtures now use real typed canonical request/outcome/callback bodies. The host codec validates those bodies before dispatch while retaining the accepted body ceilings and large-callback behavior.

The public guest ABI remains exclusively `wit/plugin.wit`. No compatibility codec, generic JSON value tree, schema/database/server route, supervisor, linker construction, UI, registry, or reference plugin is part of this slice.

## Frozen vectors and rejection evidence

Focused SDK tests freeze exact bytes, sizes, and SHA-256 values for:

- all nine invocation requests;
- success and guest-error outcomes for all nine invocation kinds;
- all eleven host-call requests and successes;
- all eight allowed host-error branches; and
- bodyless cancellation for all eleven host-call kinds.

The same suite proves context construction and WIT SHA identity; explicit option and unit representation; strict base64url; signed/unsigned integer boundaries; unknown, duplicate, omitted, reordered, whitespace, wrong kind/result/branch, changed/trailing, and over-limit rejection; clock/log error rejection; exact hash/size validation; neutral↔Wasmtime nested and unit round trips with oversized-byte rejection; and panic freedom across a bounded arbitrary-byte corpus.

## Validation

Passed from the Slice 2A.1 worktree:

```text
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked -p junban-plugin-sdk --all-targets --all-features
cargo test --locked -p junban-plugin-host --all-targets --all-features
cargo test --locked --workspace --all-features -- --test-threads=1
cargo run --locked -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen -- --check
python3 scripts/check-phase7-sdk-consumers.py
cargo audit
cargo deny check
node scripts/check-docs.mjs
git diff --check
cargo tree --locked -p junban-server -e normal  # no Wasmtime
cargo tree --locked -p junban-plugin-sdk -e normal  # no Wasmtime/wit-bindgen/Node
```

The default-parallel `cargo test --locked --workspace --all-features` run passed all changed SDK/child tests but twice encountered the existing load-sensitive two-second timeout in `junban-server` test `restore_waits_for_owned_reconfigure_commit_then_permanently_drains`. The exact test passed alone, the full workspace passed with one test thread, and the same parallel-suite timeout was reproduced without this slice at unchanged HEAD `478fb3f`; no unrelated server-test change is included here.

## API-contract recheck

Focused recheck verified that WIT remains the sole public guest ABI; code generation covers all named types and functions; canonical decoding rejects structural and byte alternates; all 9 invocation and 11 host-call request/result/error/cancel mappings are exhaustive; constructors inseparably derive kind, branch, size and hash; and all 104 generated neutral↔Wasmtime adapter pairs compile and round-trip. It marked `P7-API-001` fixed and authorized Slice 2B guest execution.

`P7-DEP-001` remains open, and no Wave 2 security gate or hostile-runtime acceptance is claimed.
