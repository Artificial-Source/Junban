# Phase 7 Wave 1 SDK-first outcome

Date: 2026-08-04
Status: **accepted** — schema-v7 migration and persistence implementation is authorized
Measured commit: `5d05eacbdfd9298eefc16c5b69f730cd2f05494e`

## Delivered authority

- `junban-plugin-sdk` is a bounded pure-Rust authority for JBP1 packages, JRI1 registries, canonical manifests, Ed25519 trust, permission scopes/hashes, dependency graphs/locks, component import inspection and the framed parent/child protocol.
- The canonical WIT is frozen at SHA-256 `5705801973219a0e6981693653f2caefdf1090345b65494750c8d8a9bf4b15f4`. Shared exact domain types, closed snapshot/event records, clear/set/default semantics, capability imports, declarative contributions and effect outcomes compile through both supported consumer profiles.
- Real pinned consumers retain source, locks, generated bindings and inspected components:
  - Rust 1.93.0, `wasm32-wasip2`, `wit-bindgen` 0.51.0: 114,120 bytes, SHA-256 `5fdaead67e8455ef7420af467f76338ca05753f62aec7b99b0dc04cd07c09372`;
  - TypeScript, jco 1.26.1, componentize-js 0.22.0, all WASI disabled: 15,317,299 bytes, retained-run SHA-256 `3ab759b2937abda036a830893aaa60d2e3227c3c6c314bcbe354282eff371f0d`.
- Default `junban-server` links only the SDK's static authority table. `--no-default-features` removes the SDK entirely. Neither server path links or initializes Wasmtime; the optional child host remains Wave 2.
- The superseded Wave 0 probe crate and generated placeholder fixtures were deleted.

## Review closure

The initial implementation gates found `P7-PKG-001`–`003` and `P7-WIT-001`–`006`. Focused corrections added pre-parse JRI1 signature/count limits, complete custom-section accounting, real exact-toolchain consumers, shared/lossless WIT types, typed fenced callback authority and fully fenced failure correlation. Focused package-security and API-contract rechecks found every ID fixed with no remaining material blocker. The finding ledger is [`phase-7-review-ledger.md`](phase-7-review-ledger.md).

## Authoritative matched-release evidence

[`phase-7-sdk-matched-release.json`](phase-7-sdk-matched-release.json) records a clean exact-commit, explicitly idle-host, five-sample-per-side run with `accepted=true`, no contention, no dirty state, one process per sample and complete cleanup.

| Release path       | Warm cgroup median | Warm cgroup maximum | Maximum peak |
| ------------------ | -----------------: | ------------------: | -----------: |
| feature-off        |         9.0352 MiB |          9.2852 MiB |   9.4766 MiB |
| default SDK-linked |         8.6484 MiB |          9.5312 MiB |   9.5820 MiB |

The default median was 0.3868 MiB below the matched feature-off median and 0.2773 MiB above the frozen Phase 6 median. Every matched-delta, Phase 6 delta, 24/32-MiB ceiling, linkage, one-process and cleanup gate passed.

## Validation

Passed on the integrated tree:

```text
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
cargo deny check
pnpm check
python3 scripts/check-phase7-sdk-consumers.py
python3 scripts/check-phase7-sdk-matched-release.py --self-check
python3 scripts/check-phase7-sdk-matched-release.py --idle-host-confirmed
```

The accepted subgate authorizes only the planned schema-v7 migration/persistence scope. Plugin runtime/process I/O, operator routes, registry artifacts, Extensions UI and reference plugins remain unimplemented and retain their later gates.
