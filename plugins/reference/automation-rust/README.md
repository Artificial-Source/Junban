# Automation Rust reference plugin

This shipped reference demonstrates Junban's Rust event subscription path. For a `task-created` event carrying a task subject, it returns exactly one existing `complete-task` domain mutation for that task ID. Junban owns operation receipts, replay, cursor advancement, and loop containment; the component keeps no receipt, cursor, or mutable state.

The package has no Junban host imports. Its only imported Junban interface is the frozen type authority included by the guest world, plus the exact bounded Rust WASI baseline produced by Rust 1.93.0.

## Check and build

Use Rust 1.93.0 with the `wasm32-wasip2` target:

```sh
cargo fmt --manifest-path plugins/reference/automation-rust/Cargo.toml -- --check
cargo test --manifest-path plugins/reference/automation-rust/Cargo.toml --locked
cargo build --manifest-path plugins/reference/automation-rust/Cargo.toml \
  --locked --release --target wasm32-wasip2
mkdir -p plugins/reference/automation-rust/artifacts
cp plugins/reference/automation-rust/target/wasm32-wasip2/release/junban_reference_automation.wasm \
  plugins/reference/automation-rust/artifacts/automation.wasm
```

The optimized retained component is `artifacts/automation.wasm`; only `target/` is ignored. `reference-authority.json` binds its canonical Linux x86_64 byte-for-byte reproducible size and hash, the frozen SDK and local-world WIT hashes, and the SDK inspection's exact sorted imports and sole guest export. The SDK permanent reference verifier recomputes and exact-checks this public authority before packaging. Fresh builds must byte-match it on canonical Linux x86_64; macOS, Windows, and other architectures must complete the locked optimized build and public artifact verification but are not required to reproduce cross-host bytes.

`plugin-source.json` is author input for Junban's SDK-owned manifest derivation and package tool. Do not add a component digest or publisher key ID to it, and do not sign from this source directory.
