# Phase 7 Slice 2E Rust fixture

This is a non-shipped conformance fixture for the real plugin composition harness. Runtime tests consume the committed `slice2e-consumer.wasm`; ordinary test runs do not need a component toolchain.

The fixture targets the frozen `junban:plugin/plugin@0.1.0` world and uses only the pinned `wit-bindgen` dependency recorded in `Cargo.lock`. `artifact-provenance.json` freezes its WIT authority, imports, size, and SHA-256 digest.

To reproduce the artifact with Rust 1.93.0 and the `wasm32-wasip2` target:

```sh
cargo build --manifest-path crates/junban-plugin-sdk/consumers/slice2e-rust/Cargo.toml \
  --locked --release --target wasm32-wasip2
cmp crates/junban-plugin-sdk/consumers/slice2e-rust/slice2e-consumer.wasm \
  crates/junban-plugin-sdk/consumers/slice2e-rust/target/wasm32-wasip2/release/junban_plugin_sdk_slice2e_consumer.wasm
```

The repository checker also verifies that both copied WIT files exactly match their authorities, the artifact stays below the JBP1 component cap, no mutable dependencies enter the lockfile, and the real host inspection reports only the frozen import set.
