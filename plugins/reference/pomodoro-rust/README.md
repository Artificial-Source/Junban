# Pomodoro Rust reference plugin

This shipped reference demonstrates Junban's Rust component authoring path, typed settings, isolated host KV, host clock, commands, and declarative view/status surfaces. The component does not run a scheduler or background thread: it derives the displayed countdown from the persisted `timer-state` value and the current host clock whenever Junban invokes it.

All mutable timer authority is stored in the plugin's bounded host KV entry. Invalid pre-existing bytes fail closed to a fresh paused work interval using the current validated settings.

## Check and build

Use Rust 1.93.0 with the `wasm32-wasip2` target:

```sh
cargo fmt --manifest-path plugins/reference/pomodoro-rust/Cargo.toml -- --check
cargo test --manifest-path plugins/reference/pomodoro-rust/Cargo.toml --locked
cargo build --manifest-path plugins/reference/pomodoro-rust/Cargo.toml \
  --locked --release --target wasm32-wasip2
mkdir -p plugins/reference/pomodoro-rust/artifacts
cp plugins/reference/pomodoro-rust/target/wasm32-wasip2/release/junban_reference_pomodoro.wasm \
  plugins/reference/pomodoro-rust/artifacts/pomodoro.wasm
```

The optimized retained component is `artifacts/pomodoro.wasm`; only `target/` is ignored. `reference-authority.json` binds its canonical Linux x86_64 byte-for-byte reproducible size and hash, the frozen SDK and local-world WIT hashes, and the SDK inspection's exact sorted imports and sole guest export. The SDK permanent reference verifier recomputes and exact-checks this public authority before packaging. Fresh builds must byte-match it on canonical Linux x86_64; macOS, Windows, and other architectures must complete the locked optimized build and public artifact verification but are not required to reproduce cross-host bytes.

`plugin-source.json` is author input for Junban's SDK-owned manifest derivation and package tool. Do not add a component digest or publisher key ID to it, and do not sign from this source directory.
