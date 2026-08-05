# Phase 7 WIT consumers

These are build/test authorities for `junban:plugin@0.1.0`, not shipped runtime code or reference plugins. Both target worlds include canonical `plugin` and select `host-tasks`, `host-settings`, `host-storage`, and `host-log`; the TypeScript world additionally selects `host-services` for its hostile import fixture. Their copied `wit/deps` package must byte-match `../../wit/plugin.wit`; the check script enforces that single authority.

- `rust/`: Rust 1.93.0, `wasm32-wasip2`, exact `wit-bindgen`/CLI 0.51.0. Checked-in generated Rust bindings compile directly. The retained component imports the selected Junban interfaces plus exactly the frozen five WASI 0.2.6 interfaces. Its test-only resource-table fixture retains raw handles from the already-frozen `wasi:cli/stderr@0.2.6` canonical ABI without adding an interface or broadening that actual import set.
- `typescript/`: build-only Node with exact jco 1.26.1 and ComponentizeJS 0.22.0 (the package override pins jco's componentizer edge), `--disable all`. Checked-in strict guest `.d.ts` bindings and the retained component have zero WASI imports.

Both source consumers implement all required guest exports and compile exercises for public types, including P1–P4 nullable priority, every unchanged/clear/set form, bulk priority clear/set, all project views, closed resync snapshots, and exact `TaskDraft::new` defaults. They also retain test-only hostile entry IDs. Rust covers ordinary trap, finite-fuel exhaustion, epoch-interrupted spin, bounded bulk memory, denied memory growth, stack exhaustion, host-resource-table saturation, bounded stderr, oversized output, per-message/field-list/per-invocation guest-log limits, a maximum-valid 8-KiB import, a 4,190,208-byte near-bound canonical import, and a 558,081-element empty-ID list whose 4,464,648 flat bytes exhaust hostcall fuel. TypeScript covers trap, spin/fuel containment, oversized output, a 558,081-element `BigInt64Array` host-service import argument whose 4,464,648 flat bytes exhaust hostcall fuel before any callback is published, and clean Store replacement; its `host-services` import is granted only in the launched-child tests. Both also expose the private test-only `memory-calibration-barrier` command: Rust page-touches 48 MiB and TypeScript page-touches 64 MiB, then each holds that valid allocation across its already-granted settings callback. The release-only process-memory harness owns that callback and replies before the one-second command deadline. These are SDK test authorities, not reference-plugin behavior.

The private parent↔child JSON body representation is separate from these guest consumers. Its checked-in pure Rust serde values and function adapters are generated from the same WIT without changing or supplementing the guest ABI. Check it without Node or runtime code generation:

```text
cargo run --locked -p junban-plugin-sdk --features codegen --bin junban-plugin-body-codegen -- --check
```

Omit `--check` only when intentionally regenerating SDK `src/private_body_types.rs` and the child host's generated neutral↔Wasmtime adapters; the command refuses a WIT SHA change until its frozen expected SHA is deliberately updated. CI byte-compares both regenerated artifacts.

## Regenerate and check

Install the TypeScript build-only lock first, then use the cross-platform Python driver (it uses Python hashing, not `sha256sum`):

```text
cd crates/junban-plugin-sdk/consumers/typescript
npm ci --ignore-scripts
cd ../../../..
python3 scripts/check-phase7-sdk-consumers.py --regenerate
python3 scripts/check-phase7-sdk-consumers.py
cargo test --locked -p junban-plugin-sdk
```

`--regenerate` intentionally updates generated bindings, retained components, and `artifact-provenance.json`. Check mode is nonmutating: it checks Rust binding/artifact reproducibility, regenerates and compares TypeScript bindings, typechecks when the repository compiler is installed, builds a fresh TypeScript component, validates exact retained hashes/imports/exports, and enforces the 32 MiB component ceiling.

ComponentizeJS/Wizer 0.22.0 output is not byte reproducible between invocations. Therefore check mode does not pretend a fresh TypeScript build must byte-match; ordinary Rust tests structurally inspect the exact retained hash-pinned artifact. Provenance records this limitation explicitly. No private signing material or JBP1 signature is involved in these SDK fixtures.
